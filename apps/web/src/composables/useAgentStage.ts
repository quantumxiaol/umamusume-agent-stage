import { computed, ref } from "vue";
import {
  AgentApiClient,
  AgentApiError,
  AgentTimeoutError,
  reconcileStageTurnActions,
  stageActionToCommand,
} from "@uma-stage/agent-client";
import {
  agentLiveStageSchema,
  type AgentStageAction,
  type AgentStageEvent,
} from "@uma-stage/contracts";
import type { StageRuntime } from "@uma-stage/core";

export type AgentStatus = "disconnected" | "connecting" | "connected" | "busy" | "error";

export interface AgentCastMember {
  characterId: string;
  displayName: string;
  stageActorId: string;
}

export interface AgentStageFrame {
  runtime: StageRuntime;
  stageId: string;
  sceneId: string;
  sceneName: string;
}

export interface AgentStageAdapter {
  getCast(): AgentCastMember[];
  getStage(): AgentStageFrame | null;
  executeTravel(
    action: Extract<AgentStageAction, { type: "actor.travel_to_scene" }>,
    signal: AbortSignal,
  ): Promise<void>;
  getActorScene(actorId: string): string | null;
  getRemoteActors(): Array<{ stageActorId: string; sceneId: string }>;
  getTravelDestinations(): Promise<Array<{
    sceneId: string;
    displayName: string;
    spawnIds: string[];
  }>>;
  nextCommandId(): string;
}

interface AgentSession {
  sessionId: string;
  userUuid: string;
  castKey: string;
  actors: Array<AgentCastMember & { agentActorId: string }>;
}

export interface ConversationLine {
  id: string;
  speaker: string;
  text: string;
  kind: "trainer" | "character" | "action" | "command" | "narrator" | "system";
}

interface PendingAgentReply {
  event: AgentStageEvent;
  stageActorId: string | null;
  actionShown: boolean;
  dialogueShown: boolean;
}

interface AgentOperation {
  controller: AbortController;
  tasks: Set<ReturnType<StageRuntime["execute"]>>;
}

export function useAgentStage(options: {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  adapter: AgentStageAdapter;
}) {
  const agentStatus = ref<AgentStatus>("disconnected");
  const agentStatusMessage = ref("正在等待舞台初始化…");
  const agentCharacters = ref<string[]>([]);
  const agentMaxParticipants = ref(3);
  const agentSupportsTravel = ref(false);
  const agentInput = ref("");
  const conversation = ref<ConversationLine[]>([]);
  const canRetryTurn = computed(() => failedMessage.value !== "");
  let agentClient: AgentApiClient | null = null;
  let agentSession: AgentSession | null = null;
  let activeOperation: AgentOperation | null = null;
  let conversationSequence = 0;
  const failedMessage = ref("");

  function beginOperation(): AgentOperation {
    cancelOperation("已被新的 Agent 操作替换");
    const operation: AgentOperation = { controller: new AbortController(), tasks: new Set() };
    activeOperation = operation;
    return operation;
  }

  function cancelOperation(reason: string): void {
    const operation = activeOperation;
    if (!operation) return;
    activeOperation = null;
    operation.controller.abort(new DOMException(reason, "AbortError"));
    for (const task of operation.tasks) task.cancel(reason);
    operation.tasks.clear();
  }

  function isCurrent(operation: AgentOperation): boolean {
    return activeOperation === operation && !operation.controller.signal.aborted;
  }

  function finishOperation(operation: AgentOperation): void {
    if (activeOperation === operation) activeOperation = null;
  }

  async function connectAgent(operation: AgentOperation): Promise<void> {
    if (!options.enabled) return;
    agentStatus.value = "connecting";
    agentStatusMessage.value = "正在连接 Agent 并核对舞台能力…";
    const client = new AgentApiClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
    const signal = operation.controller.signal;
    const [characters, stageCapabilities, serverCapabilities] = await Promise.all([
      client.listCharacters(signal),
      client.stageCapabilities(signal),
      client.serverCapabilities(signal),
    ]);
    if (!isCurrent(operation)) return;
    agentClient = client;
    agentCharacters.value = characters;
    agentSupportsTravel.value = stageCapabilities.supportedActions.includes("actor.travel_to_scene");
    agentMaxParticipants.value = Math.min(4, serverCapabilities.directorMaxParticipants ?? 3);
    agentStatus.value = "connected";
    agentStatusMessage.value = `已连接 · Agent ${characters.length} 名角色 · 最多 ${agentMaxParticipants.value} 名出演角色`;
  }

  async function createAgentSession(
    operation: AgentOperation,
    preserveConversation = false,
  ): Promise<boolean> {
    const cast = options.adapter.getCast();
    if (cast.length === 0 || !agentClient) return false;
    if (cast.length > agentMaxParticipants.value) {
      throw new Error(`当前 Agent 最多支持 ${agentMaxParticipants.value} 名出演角色，请先减少同行角色`);
    }
    const unavailable = cast.filter((member) => !agentCharacters.value.includes(member.displayName));
    if (unavailable.length > 0) {
      throw new Error(`Agent 尚未提供角色：${unavailable.map((member) => member.displayName).join("、")}`);
    }
    const stage = options.adapter.getStage();
    if (!stage) throw new Error("舞台尚未就绪，暂时无法创建角色会话");
    agentStatus.value = "busy";
    agentStatusMessage.value = `正在安排 ${cast.length} 位角色入场…`;
    const session = await agentClient.createStageSession({
      characterNames: cast.map((member) => member.displayName),
      sceneName: stage.sceneName,
    }, operation.controller.signal);
    if (!isCurrent(operation)) return false;
    const actors = cast.map((member) => {
      const agentActor = session.actors.find(
        (actor) => actor.actorType === "umamusume" && actor.displayName === member.displayName,
      );
      if (!agentActor) throw new Error(`Agent 会话未返回角色 actor_id：${member.displayName}`);
      return { ...member, agentActorId: agentActor.actorId };
    });
    agentSession = {
      sessionId: session.sessionId,
      userUuid: session.userUuid,
      castKey: castKey(cast),
      actors,
    };
    if (!preserveConversation) {
      conversation.value = [];
      failedMessage.value = "";
    }
    pushConversation("system", "舞台", `${cast.map((member) => member.displayName).join("、")} 已进入角色会话`);
    agentStatus.value = "connected";
    agentStatusMessage.value = `${cast.length} 位角色会话已就绪`;
    return true;
  }

  async function prepareAgentSession(preserveConversation = false): Promise<boolean> {
    if (!options.enabled) return false;
    const operation = beginOperation();
    try {
      await connectAgent(operation);
      if (!isCurrent(operation)) return false;
      return await createAgentSession(operation, preserveConversation);
    } catch (error) {
      if (!isCurrent(operation)) return false;
      agentStatus.value = "error";
      agentStatusMessage.value = formatAgentError(error);
      return false;
    } finally {
      finishOperation(operation);
    }
  }

  async function sendAgentMessage(reuseTrainerLine = false): Promise<void> {
    const message = agentInput.value.trim();
    const cast = options.adapter.getCast();
    if (!options.enabled || !message || cast.length === 0 || agentStatus.value === "busy") return;
    const operation = beginOperation();
    let pendingReplies: PendingAgentReply[] = [];
    let receivedTurn = false;
    try {
      if (!agentClient) await connectAgent(operation);
      if (!isCurrent(operation)) return;
      const expectedCastKey = castKey(cast);
      if (!agentSession || agentSession.castKey !== expectedCastKey) {
        if (!(await createAgentSession(operation))) return;
      }
      const session = agentSession;
      const stage = options.adapter.getStage();
      if (!session || !agentClient || !stage) throw new Error("舞台或 Agent 会话尚未就绪");
      const presentStageActorIds = new Set(stage.runtime.snapshot().actors.map((state) => state.actor_id));
      const presentSessionActors = session.actors.filter((binding) => presentStageActorIds.has(binding.stageActorId));
      const supportsTravel = agentSupportsTravel.value;
      if (!supportsTravel && presentSessionActors.length === 0) {
        agentStatus.value = "connected";
        agentStatusMessage.value = "当前 Agent 版本不支持跨图召回，请更新并重启后端";
        return;
      }

      const remoteSceneByActorId = new Map(
        (supportsTravel ? options.adapter.getRemoteActors() : [])
          .map((actor) => [actor.stageActorId, actor.sceneId] as const),
      );
      const turnActors = supportsTravel
        ? session.actors.flatMap((binding) => {
            const actorScene = options.adapter.getActorScene(binding.stageActorId);
            const present = presentStageActorIds.has(binding.stageActorId) &&
              (actorScene === null || actorScene === stage.sceneId);
            const sceneId = present
              ? stage.sceneId
              : remoteSceneByActorId.get(binding.stageActorId) ?? actorScene;
            return sceneId ? [{ binding, sceneId, present }] : [];
          })
        : presentSessionActors.map((binding) => ({ binding, sceneId: stage.sceneId, present: true }));
      if (turnActors.length === 0) throw new Error("当前 Agent 会话没有可定位的出演角色");

      failedMessage.value = message;
      agentInput.value = "";
      if (!reuseTrainerLine) pushConversation("trainer", "训练员", message);
      agentStatus.value = "busy";
      agentStatusMessage.value = "角色正在生成对白与舞台行为…";
      const destinations = supportsTravel ? await options.adapter.getTravelDestinations() : [];
      if (!isCurrent(operation)) return;
      const actorBindings = turnActors.map(({ binding, sceneId }) => ({
        agent_actor_id: binding.agentActorId,
        stage_actor_id: binding.stageActorId,
        ...(supportsTravel ? { scene_id: sceneId } : {}),
      }));
      const liveStage = agentLiveStageSchema.parse({
        schema_version: "live_stage.v1",
        stage_id: stage.stageId,
        scene_id: stage.sceneId,
        ...stage.runtime.inspect(),
        remote_actors: turnActors.filter((actor) => !actor.present).map((actor) => ({
          actor_id: actor.binding.stageActorId,
          scene_id: actor.sceneId,
        })),
        travel_destinations: destinations.map((destination) => ({
          scene_id: destination.sceneId,
          display_name: destination.displayName,
          spawn_ids: destination.spawnIds,
        })),
      });
      const result = await agentClient.turn({
        sessionId: session.sessionId,
        userUuid: session.userUuid,
        message,
        targetActorIds: turnActors.map((actor) => actor.binding.agentActorId),
        actorBindings,
        liveStage,
      }, operation.controller.signal);
      if (!isCurrent(operation) || options.adapter.getStage()?.runtime !== stage.runtime) return;
      receivedTurn = true;
      pendingReplies = result.events.flatMap((event) => {
        if (event.event_type !== "character_reply") return [];
        const binding = session.actors.find((candidate) => candidate.agentActorId === event.actor?.actor_id);
        return [{ event, stageActorId: binding?.stageActorId ?? null, actionShown: false, dialogueShown: false }];
      });
      for (const event of result.events) {
        if (event.event_type === "narration" || event.event_type === "scene_change") {
          pushConversation("narrator", "环境", event.content);
        }
      }
      const actions = reconcileStageTurnActions(result, actorBindings);
      const boundStageActorIds = new Set(actorBindings.map((binding) => binding.stage_actor_id));
      for (const action of actions) {
        if (!isCurrent(operation)) return;
        if (!boundStageActorIds.has(action.actor_id)) throw new Error(`Agent 返回了未绑定角色动作：${action.actor_id}`);
        pushConversation("command", "StageCommand", formatAgentAction(action));
        const replyRevealed = revealReplyForAgentAction(pendingReplies, action);
        let currentStage = options.adapter.getStage();
        let actorScene = supportsTravel ? options.adapter.getActorScene(action.actor_id) : null;
        if (action.type === "actor.travel_to_scene") {
          await options.adapter.executeTravel(action, operation.controller.signal);
          if (!isCurrent(operation)) return;
          continue;
        }

        if (!currentStage) throw new Error("舞台尚未就绪，无法执行 Agent 动作");
        let actorPresent = isActorInCurrentScene(currentStage, action.actor_id, actorScene);
        if (supportsTravel && (action.type === "actor.approach" || action.type === "actor.follow") && !actorPresent) {
          await options.adapter.executeTravel({
            type: "actor.travel_to_scene",
            actor_id: action.actor_id,
            target_scene_id: currentStage.sceneId,
          }, operation.controller.signal);
          if (!isCurrent(operation)) return;
          currentStage = options.adapter.getStage();
          if (!currentStage) throw new Error("跨图召回后舞台尚未就绪");
          actorScene = options.adapter.getActorScene(action.actor_id);
          actorPresent = isActorInCurrentScene(currentStage, action.actor_id, actorScene);
          if (!actorPresent) {
            throw new Error(`角色跨图召回后仍未进入当前场景：${action.actor_id}`);
          }
        }
        if (!actorPresent) {
          if (action.type === "dialogue.say") {
            if (!replyRevealed) {
              const speaker = session.actors.find((binding) => binding.stageActorId === action.actor_id)?.displayName ?? "角色";
              pushConversation("character", speaker, action.text);
            }
            continue;
          }
          throw new Error(`角色不在当前场景：${action.actor_id} · ${formatAgentAction(action)}`);
        }

        const actorState = currentStage.runtime.snapshot().actors.find((state) => state.actor_id === action.actor_id);
        if (actorState?.control_owner !== "agent") currentStage.runtime.setControlOwner(action.actor_id, "agent");
        const task = currentStage.runtime.execute(stageActionToCommand(action, options.adapter.nextCommandId()));
        operation.tasks.add(task);
        try {
          const commandResult = await task.completion;
          if (!isCurrent(operation)) return;
          if (commandResult.status !== "completed") {
            throw new Error(
              `舞台动作执行失败（${formatAgentAction(action)}）：${commandResult.status}` +
              `${commandResult.error?.message ? ` · ${commandResult.error.message}` : ""}`,
            );
          }
        } finally {
          operation.tasks.delete(task);
        }
      }
      revealPendingAgentReplies(pendingReplies);
      if (!isCurrent(operation)) return;
      failedMessage.value = "";
      agentStatus.value = "connected";
      agentStatusMessage.value = `第 ${result.turn_index} 轮完成 · ${actions.length} 条舞台动作`;
    } catch (error) {
      if (!isCurrent(operation)) return;
      revealPendingAgentReplies(pendingReplies);
      if (isAbortError(error)) {
        restoreCancelledMessage();
        return;
      }
      if (error instanceof AgentApiError && error.status === 404) {
        agentSession = null;
        agentStatusMessage.value = "会话已失效。请重新连接后再发送这一轮。";
      } else {
        agentStatusMessage.value = `${receivedTurn ? "本轮回复已保留，但动作未全部完成 · " : ""}${formatAgentError(error)}`;
      }
      agentStatus.value = "error";
    } finally {
      finishOperation(operation);
    }
  }

  function cancelAgentTurn(): void {
    if (!activeOperation) return;
    cancelOperation("用户取消了本轮对话");
    restoreCancelledMessage();
  }

  function restoreCancelledMessage(): void {
    if (failedMessage.value) {
      agentInput.value = failedMessage.value;
      failedMessage.value = "";
    }
    agentStatus.value = agentSession ? "connected" : "disconnected";
    agentStatusMessage.value = "已取消本轮操作，可以修改后重新发送";
  }

  function invalidateAgent(reason: string): void {
    if (!activeOperation) return;
    cancelOperation(reason);
    restoreCancelledMessage();
    agentStatusMessage.value = "舞台已切换，上一轮操作已取消，请重新发送";
  }

  function resetAgentSession(clearConversation = true): void {
    cancelOperation("角色会话已重置");
    agentSession = null;
    failedMessage.value = "";
    if (clearConversation) conversation.value = [];
    agentStatus.value = "disconnected";
    agentStatusMessage.value = "等待重新连接 Agent";
  }

  async function retryAgentSession(): Promise<void> {
    const retryMessage = failedMessage.value;
    if (!(await prepareAgentSession(retryMessage !== ""))) return;
    if (!retryMessage) return;
    agentInput.value = retryMessage;
    await sendAgentMessage(true);
  }

  function revealReplyForAgentAction(replies: PendingAgentReply[], action: AgentStageAction): boolean {
    if (action.type === "dialogue.say") {
      const normalizedText = action.text.trim();
      const reply = replies.find((candidate) =>
        !candidate.dialogueShown && candidate.stageActorId === action.actor_id &&
        (candidate.event.dialogue.trim() || candidate.event.content.trim()) === normalizedText,
      ) ?? replies.find((candidate) => !candidate.dialogueShown && candidate.stageActorId === action.actor_id);
      if (!reply) return false;
      revealAgentReplyAction(reply);
      pushConversation("character", reply.event.actor?.display_name ?? "角色", reply.event.dialogue || reply.event.content);
      reply.dialogueShown = true;
      return true;
    }
    const reply = replies.find((candidate) => !candidate.actionShown && candidate.stageActorId === action.actor_id);
    if (reply) revealAgentReplyAction(reply);
    return false;
  }

  function revealAgentReplyAction(reply: PendingAgentReply): void {
    if (reply.actionShown || !reply.event.action.trim()) return;
    pushConversation("action", reply.event.actor?.display_name ?? "角色", reply.event.action);
    reply.actionShown = true;
  }

  function revealPendingAgentReplies(replies: PendingAgentReply[]): void {
    for (const reply of replies) {
      revealAgentReplyAction(reply);
      if (reply.dialogueShown) continue;
      pushConversation("character", reply.event.actor?.display_name ?? "角色", reply.event.dialogue || reply.event.content);
      reply.dialogueShown = true;
    }
  }

  function pushConversation(kind: ConversationLine["kind"], speaker: string, text: string): void {
    if (!text.trim()) return;
    conversationSequence += 1;
    conversation.value.push({ id: `line-${conversationSequence}`, speaker, text: text.trim(), kind });
  }

  return {
    agentStatus,
    agentStatusMessage,
    agentCharacters,
    agentMaxParticipants,
    agentSupportsTravel,
    agentInput,
    conversation,
    canRetryTurn,
    prepareAgentSession,
    sendAgentMessage,
    cancelAgentTurn,
    invalidateAgent,
    resetAgentSession,
    retryAgentSession,
    pushConversation,
  };
}

function isActorInCurrentScene(
  stage: AgentStageFrame,
  actorId: string,
  actorScene: string | null,
): boolean {
  if (typeof actorScene === "string" && actorScene !== stage.sceneId) return false;
  return stage.runtime.snapshot().actors.some((actor) => actor.actor_id === actorId);
}

function castKey(cast: AgentCastMember[]): string {
  return cast.map((member) => member.characterId).join("|");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function formatAgentError(error: unknown): string {
  if (error instanceof AgentTimeoutError) {
    return `Agent 请求超过 ${Math.round(error.timeoutMs / 1000)} 秒未响应，请稍后重试`;
  }
  if (error instanceof AgentApiError) {
    const details = Array.isArray(error.detail)
      ? error.detail.map((item) => formatValidationDetail(item)).filter(Boolean).join("；")
      : typeof error.detail === "string" ? error.detail : "";
    const retryAfter = error.retryAfter ? ` · 请在 ${error.retryAfter} 秒后重试` : "";
    return `Agent API ${error.status}${details ? `：${details}` : ""}${retryAfter}`;
  }
  if (error instanceof TypeError) {
    return `无法连接 Agent，请检查服务地址与跨域配置（${error.message}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatValidationDetail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const detail = value as { msg?: unknown; loc?: unknown };
  const location = Array.isArray(detail.loc) ? detail.loc.filter((part) => part !== "body").join(".") : "";
  const message = typeof detail.msg === "string" ? detail.msg : "请求参数无效";
  return location ? `${location}：${message}` : message;
}

function formatAgentAction(action: AgentStageAction): string {
  if (action.type === "actor.move_to") return `move_to → ${action.anchor_id}${action.slot_id ? ` / ${action.slot_id}` : ""}`;
  if (action.type === "actor.approach") return `approach → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  if (action.type === "actor.follow") return `follow → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  if (action.type === "actor.stop_follow") return "stop_follow";
  if (action.type === "actor.travel_to_scene") return `travel_to_scene → ${action.target_scene_id}`;
  if (action.type === "actor.face_actor") return `face_actor → ${action.target_actor_id}`;
  if (action.type === "actor.face") return `face → ${action.facing}`;
  if (action.type === "dialogue.say") return `say → ${action.text}`;
  return action.type;
}
