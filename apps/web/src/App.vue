<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  AgentApiClient,
  AgentApiError,
  stageActionToCommand,
} from "@uma-stage/agent-client";
import {
  agentLiveStageSchema,
  characterAgentMappingSchema,
  characterPackSchema,
  characterRegistrySchema,
  scenePackSchema,
  stageDefinitionSchema,
  stageRegistrySchema,
  type CharacterAgentMapping,
  type CharacterAgentMappingEntry,
  type CharacterPack,
  type CharacterRegistry,
  type AgentStageAction,
  type ScenePack,
  type StageActorState,
  type StageDefinition,
  type StageEvent,
  type StageRegistry,
  type StageRegistryEntry,
} from "@uma-stage/contracts";
import { assignStageSpawns, StageRuntime, type CommandResult } from "@uma-stage/core";

import { useStageStore } from "./stores/stage";

type RendererModule = typeof import("@uma-stage/renderer-phaser");
type StageGame = ReturnType<RendererModule["createStageGame"]>;
type AgentStatus = "disconnected" | "connecting" | "connected" | "busy" | "error";
type Outfit = "uniform" | "race_outfit";

interface ActorPresentation {
  instanceId: string;
  displayName: string;
  player: boolean;
  initials: string;
}

interface AgentSession {
  sessionId: string;
  userUuid: string;
  characterId: string;
  agentActorId: string;
}

interface ConversationLine {
  id: string;
  speaker: string;
  text: string;
  kind: "trainer" | "character" | "action" | "command" | "narrator" | "system";
}

interface FollowBinding {
  actorId: string;
  targetActorId: string;
  distanceTiles: number;
}

const environment = import.meta.env as unknown as Record<string, string | undefined>;
const defaultAgentUrl =
  environment.UMAMUSUME_AGENT_URL?.trim() ||
  environment.VITE_UMAMUSUME_AGENT_URL?.trim() ||
  "http://127.0.0.1:1111";
const configuredAgentKey =
  environment.UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() ||
  environment.VITE_UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() ||
  "";

const stageElement = ref<HTMLElement | null>(null);
const store = useStageStore();
const stageName = ref("特雷森学生广场");
const currentStageId = ref("");
const actorViews = ref<ActorPresentation[]>([]);
const stageChoices = ref<StageRegistryEntry[]>([]);
const activeStagePath = ref("");
const currentSceneId = ref("");
const currentPlayerActorId = ref("");
const sceneAnchors = ref<Array<{ id: string; displayName: string }>>([]);
const sceneZones = ref<Array<{ id: string; displayName: string }>>([]);
const activityPaths = ref<Array<{ id: string; activityId: string }>>([]);
const characterMappings = ref<CharacterAgentMappingEntry[]>([]);
const selectedCharacterId = ref("admire_vega");
const selectedOutfit = ref<Outfit>("uniform");
const activeActorId = ref("uma_admire_vega");

const agentStatus = ref<AgentStatus>("disconnected");
const agentStatusMessage = ref("正在等待舞台初始化…");
const agentCharacters = ref<string[]>([]);
const agentSession = ref<AgentSession | null>(null);
const agentInput = ref("");
const conversation = ref<ConversationLine[]>([]);

const activeMapping = computed(() =>
  characterMappings.value.find((entry) => entry.character_id === selectedCharacterId.value),
);
const activeCharacterName = computed(
  () => activeMapping.value?.agent_character_name ?? selectedCharacterId.value,
);
const activeActorFollowsPlayer = computed(
  () => actor(activeActorId.value)?.following_actor_id === currentPlayerActorId.value,
);

let runtime: StageRuntime | null = null;
let game: StageGame | null = null;
let agentClient: AgentApiClient | null = null;
let unsubscribe: (() => void) | null = null;
let snapshotTimer: number | null = null;
let generation = 0;
let commandSequence = 0;
let conversationSequence = 0;
let portalTransitionPending = false;
let portalTransitionTimer: number | null = null;
let runPortalTransition: (() => void) | null = null;
const PORTAL_TRANSITION_FALLBACK_MS = 750;
const PORTAL_TRANSITION_AFTER_COMMAND_MS = 50;

onMounted(() => void initializeApplication());
onBeforeUnmount(dispose);

async function initializeApplication(): Promise<void> {
  await initialize();
  if (store.phase !== "ready") return;
  await prepareAgentSession();
}

async function initialize(
  definitionPath?: string,
  spawnOverrides: Record<string, string> = {},
  followBindings: FollowBinding[] = [],
): Promise<void> {
  const currentGeneration = ++generation;
  dispose(false);
  portalTransitionPending = false;
  store.reset();
  actorViews.value = [];
  try {
    const [registry, stageRegistry, mapping] = await Promise.all([
      loadCharacterRegistry(contentUrl("characters/registry.json")),
      loadStageRegistry(contentUrl("stages/registry.json")),
      loadCharacterMapping(contentUrl("characters/agent-mapping.json")),
    ]);
    characterMappings.value = mapping.characters;
    const selected =
      mapping.characters.find((entry) => entry.character_id === selectedCharacterId.value) ??
      mapping.characters[0];
    if (!selected) throw new Error("角色映射为空");
    selectedCharacterId.value = selected.character_id;
    activeActorId.value = selected.stage_actor_id;

    const requestedStagePath =
      definitionPath || activeStagePath.value || stageRegistry.default_definition_path;
    const sourceStage = await loadStage(contentUrl(requestedStagePath));
    const stage = applyCharacterSelection(sourceStage, selected, selectedOutfit.value);
    const registryByBundle = new Map(
      registry.characters.map((entry) => [entry.bundle_id, entry]),
    );
    const [scene, renderer, ...packs] = await Promise.all([
      loadScene(contentUrl(stage.scene_path)),
      import("@uma-stage/renderer-phaser"),
      ...stage.actors.map((actorDefinition) => {
        const entry = registryByBundle.get(actorDefinition.bundle_id);
        if (!entry) {
          throw new Error(`舞台引用了未注册角色：${actorDefinition.bundle_id}`);
        }
        return loadActor(contentUrl(entry.actor_path));
      }),
    ]);
    if (currentGeneration !== generation) return;

    const nextRuntime = new StageRuntime(scene);
    const playerActorId = stage.actors.find(
      (actorDefinition) => actorDefinition.player,
    )?.instance_id;
    const assignedSpawns = assignStageSpawns(stage.actors, scene, spawnOverrides);
    const rendererActors = stage.actors.map((actorDefinition, index) => {
      const pack = packs[index];
      if (!pack) throw new Error(`缺少角色包：${actorDefinition.bundle_id}`);
      const registryEntry = registryByBundle.get(actorDefinition.bundle_id);
      if (!registryEntry) throw new Error(`缺少角色注册项：${actorDefinition.bundle_id}`);
      nextRuntime.spawnActor({
        actorId: actorDefinition.instance_id,
        characterPack: pack,
        spawnId: assignedSpawns[actorDefinition.instance_id] ?? actorDefinition.spawn_id,
        controlOwner: actorDefinition.control_owner,
      });
      return {
        actorId: actorDefinition.instance_id,
        pack,
        bundleBaseUrl: contentDirectoryUrl(registryEntry.actor_path),
      };
    });
    for (const binding of followBindings) {
      if (!stage.actors.some((actorDefinition) => actorDefinition.instance_id === binding.actorId)) continue;
      if (!stage.actors.some((actorDefinition) => actorDefinition.instance_id === binding.targetActorId)) continue;
      nextRuntime.execute({
        id: nextCommandId("portal-follow"),
        type: "actor.follow",
        actor_id: binding.actorId,
        target_actor_id: binding.targetActorId,
        distance_tiles: binding.distanceTiles,
        source: "system",
        policy: "replace",
      });
    }
    runtime = nextRuntime;
    unsubscribe = nextRuntime.subscribe((event) => {
      store.pushEvent(event);
      handlePortalEvent(event, playerActorId, stageRegistry);
    });
    store.setSnapshot(nextRuntime.snapshot());
    stageName.value = stage.display_name;
    currentStageId.value = stage.stage_id;
    stageChoices.value = stageRegistry.stages;
    activeStagePath.value = requestedStagePath;
    currentSceneId.value = scene.scene_id;
    currentPlayerActorId.value = playerActorId ?? "";
    sceneAnchors.value = scene.anchors.map((anchor) => ({
      id: anchor.id,
      displayName: anchor.display_name,
    }));
    sceneZones.value = scene.zones.map((zone) => ({
      id: zone.id,
      displayName: zone.display_name,
    }));
    activityPaths.value = scene.activity_paths.map((path) => ({
      id: path.id,
      activityId: path.activity_id,
    }));
    actorViews.value = stage.actors.map((actorDefinition, index) => ({
      instanceId: actorDefinition.instance_id,
      displayName: packs[index]?.display_name ?? actorDefinition.instance_id,
      player: actorDefinition.player,
      initials: initials(packs[index]?.display_name ?? actorDefinition.instance_id),
    }));

    const parent = stageElement.value;
    if (!parent) throw new Error("舞台挂载点不存在");
    game = renderer.createStageGame({
      parent,
      runtime: nextRuntime,
      scene,
      sceneBaseUrl: contentDirectoryUrl(stage.scene_path),
      ...(playerActorId === undefined ? {} : { playerActorId }),
      actors: rendererActors,
    });
    snapshotTimer = window.setInterval(() => {
      if (runtime) store.setSnapshot(runtime.snapshot());
    }, 100);
    store.ready();
  } catch (error) {
    if (currentGeneration === generation) store.fail(error);
  }
}

function applyCharacterSelection(
  stage: StageDefinition,
  mapping: CharacterAgentMappingEntry,
  outfit: Outfit,
): StageDefinition {
  const bundleId =
    outfit === "uniform" ? mapping.uniform_bundle_id : mapping.race_outfit_bundle_id;
  let replaced = false;
  return {
    ...stage,
    actors: stage.actors.map((actorDefinition) => {
      if (replaced || actorDefinition.player || actorDefinition.control_owner !== "agent") {
        return actorDefinition;
      }
      replaced = true;
      return {
        ...actorDefinition,
        instance_id: mapping.stage_actor_id,
        bundle_id: bundleId,
      };
    }),
  };
}

function handlePortalEvent(
  event: StageEvent,
  playerActorId: string | undefined,
  stageRegistry: StageRegistry,
): void {
  if (
    portalTransitionPending &&
    event.type === "command.completed" &&
    event.actor_id === playerActorId &&
    runPortalTransition
  ) {
    if (portalTransitionTimer !== null) window.clearTimeout(portalTransitionTimer);
    portalTransitionTimer = window.setTimeout(
      runPortalTransition,
      PORTAL_TRANSITION_AFTER_COMMAND_MS,
    );
    return;
  }
  if (
    portalTransitionPending ||
    event.type !== "portal.entered" ||
    event.actor_id !== playerActorId
  ) return;
  const targetSceneId = event.data.target_scene_id;
  const targetSpawnId = event.data.target_spawn_id;
  if (typeof targetSceneId !== "string" || typeof targetSpawnId !== "string") return;
  const target = stageRegistry.stages.find((entry) => entry.scene_id === targetSceneId);
  if (!target || !playerActorId) return;
  portalTransitionPending = true;
  store.setMessage(`区域切换：前往${target.display_name}`);
  runPortalTransition = () => {
    portalTransitionTimer = null;
    runPortalTransition = null;
    void initialize(
      target.definition_path,
      { [playerActorId]: targetSpawnId },
      captureFollowBindings(runtime),
    );
  };
  portalTransitionTimer = window.setTimeout(
    runPortalTransition,
    PORTAL_TRANSITION_FALLBACK_MS,
  );
}

function dispose(invalidate = true): void {
  if (invalidate) generation += 1;
  if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
  snapshotTimer = null;
  if (portalTransitionTimer !== null) window.clearTimeout(portalTransitionTimer);
  portalTransitionTimer = null;
  runPortalTransition = null;
  unsubscribe?.();
  unsubscribe = null;
  game?.destroy();
  game = null;
  runtime = null;
}

async function changeCharacter(): Promise<void> {
  agentSession.value = null;
  conversation.value = [];
  await initialize(activeStagePath.value);
  if (store.phase === "ready") await prepareAgentSession();
}

async function changeOutfit(): Promise<void> {
  await initialize(activeStagePath.value);
}

async function runMeeting(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "script");
  store.setMessage(`脚本接管：${activeCharacterName.value}正在前往喷泉会面点`);
  const movement = activeRuntime.execute({
    id: nextCommandId("meeting"),
    type: "actor.move_to",
    actor_id: actorId,
    source: "script",
    policy: "replace",
    target: { type: "anchor", id: "fountain_meeting" },
  });
  const result = await movement.completion;
  if (activeRuntime !== runtime || result.status !== "completed") {
    describeResult(result);
    return;
  }
  store.setMessage(`${activeCharacterName.value}已到达交互槽位`);
  const speech = activeRuntime.execute({
    id: nextCommandId("say"),
    type: "dialogue.say",
    actor_id: actorId,
    source: "script",
    policy: "replace",
    text: "训练员，下一项安排是什么？",
  });
  await speech.completion;
  if (activeRuntime === runtime) {
    activeRuntime.setControlOwner(actorId, "agent");
    store.setMessage("演出完成，控制权已归还 agent");
  }
}

async function sendActorTo(anchorId: string, label: string): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  store.setMessage(`agent 指令：${activeCharacterName.value}前往${label}`);
  const task = activeRuntime.execute({
    id: nextCommandId("move"),
    type: "actor.move_to",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
    target: { type: "anchor", id: anchorId },
  });
  const result = await task.completion;
  if (activeRuntime === runtime) describeResult(result, `${label}已到达`);
}

async function runActivityPath(pathId: string, activityId: string): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  store.setMessage(`agent 指令：${activeCharacterName.value}执行 ${activityId}`);
  const task = activeRuntime.execute({
    id: nextCommandId("activity"),
    type: "actor.follow_activity_path",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
    activity_path_id: pathId,
    cycles: 1,
  });
  const result = await task.completion;
  if (activeRuntime === runtime) describeResult(result, `${activityId} 已完成`);
}

async function startActorFollow(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  const targetActorId = currentPlayerActorId.value;
  if (!activeRuntime || !targetActorId) return;
  activeRuntime.setControlOwner(actorId, "agent");
  const result = await activeRuntime.execute({
    id: nextCommandId("follow"),
    type: "actor.follow",
    actor_id: actorId,
    target_actor_id: targetActorId,
    distance_tiles: 2,
    source: "agent",
    policy: "replace",
  }).completion;
  if (activeRuntime === runtime) describeResult(result, `${activeCharacterName.value}会持续跟随训练员`);
}

async function stopActorFollow(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  const result = await activeRuntime.execute({
    id: nextCommandId("stop-follow"),
    type: "actor.stop_follow",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
  }).completion;
  if (activeRuntime === runtime) describeResult(result, `${activeCharacterName.value}已停止跟随`);
}

function followCamera(actorId: string): void {
  game?.setCameraCue({ type: "camera.follow_actor", actor_id: actorId, zoom: 0.8 });
}

function focusCameraOnAnchor(anchorId: string): void {
  game?.setCameraCue({ type: "camera.focus_anchor", anchor_id: anchorId, zoom: 0.8 });
}

function focusCameraOnZone(zoneId: string): void {
  game?.setCameraCue({ type: "camera.focus_zone", zone_id: zoneId, zoom: 0.8 });
}

function showCameraOverview(): void {
  game?.setCameraCue({ type: "camera.overview" });
}

async function connectAgent(): Promise<boolean> {
  agentStatus.value = "connecting";
  agentStatusMessage.value = "正在从 .env 配置连接 Agent…";
  try {
    const client = new AgentApiClient({
      baseUrl: defaultAgentUrl,
      apiKey: configuredAgentKey,
    });
    const [characters] = await Promise.all([
      client.listCharacters(),
      client.stageCapabilities(),
    ]);
    agentClient = client;
    agentCharacters.value = characters;
    agentStatus.value = "connected";
    agentStatusMessage.value = `已连接 · Agent ${characters.length} 角色 / Stage ${characterMappings.value.length} 角色`;
    return true;
  } catch (error) {
    agentClient = null;
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
    return false;
  }
}

async function prepareAgentSession(): Promise<boolean> {
  if (!(await connectAgent())) return false;
  return createAgentSession();
}

async function createAgentSession(): Promise<boolean> {
  const mapping = activeMapping.value;
  if (!mapping) return false;
  if (!agentClient && !(await connectAgent())) return false;
  if (!agentClient) return false;
  if (!agentCharacters.value.includes(mapping.agent_character_name)) {
    agentStatus.value = "error";
    agentStatusMessage.value = `Agent 尚未提供角色：${mapping.agent_character_name}`;
    return false;
  }
  agentStatus.value = "busy";
  agentStatusMessage.value = `正在加载 ${mapping.agent_character_name}…`;
  try {
    const session = await agentClient.createStageSession({
      characterNames: [mapping.agent_character_name],
      sceneName: stageName.value,
    });
    const agentActor = session.actors.find(
      (actor) =>
        actor.actorType === "umamusume" &&
        actor.displayName === mapping.agent_character_name,
    );
    if (!agentActor) {
      throw new Error(`Agent 会话未返回角色 actor_id：${mapping.agent_character_name}`);
    }
    agentSession.value = {
      sessionId: session.sessionId,
      userUuid: session.userUuid,
      characterId: mapping.character_id,
      agentActorId: agentActor.actorId,
    };
    conversation.value = [];
    pushConversation("system", "舞台", `${mapping.agent_character_name} 已进入角色会话`);
    agentStatus.value = "connected";
    agentStatusMessage.value = `${mapping.agent_character_name} 会话已就绪`;
    return true;
  } catch (error) {
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
    return false;
  }
}

async function sendAgentMessage(): Promise<void> {
  const message = agentInput.value.trim();
  const mapping = activeMapping.value;
  const activeRuntime = runtime;
  if (!message || !mapping || !activeRuntime || agentStatus.value === "busy") return;
  if (
    !agentSession.value ||
    agentSession.value.characterId !== mapping.character_id
  ) {
    if (!(await createAgentSession())) return;
  }
  const session = agentSession.value;
  if (!session || !agentClient) return;

  agentInput.value = "";
  pushConversation("trainer", "训练员", message);
  agentStatus.value = "busy";
  agentStatusMessage.value = "角色正在生成对白与舞台行为…";
  try {
    const liveStage = agentLiveStageSchema.parse({
      schema_version: "live_stage.v1",
      stage_id: currentStageId.value,
      scene_id: currentSceneId.value,
      ...activeRuntime.inspect(),
    });
    const result = await agentClient.turn({
      sessionId: session.sessionId,
      userUuid: session.userUuid,
      message,
      targetActorIds: [session.agentActorId],
      actorBindings: [
        {
          agent_actor_id: session.agentActorId,
          stage_actor_id: mapping.stage_actor_id,
        },
      ],
      liveStage,
    });
    for (const event of result.events) {
      if (event.event_type === "character_reply") {
        if (event.action) {
          pushConversation(
            "action",
            event.actor?.display_name ?? mapping.agent_character_name,
            event.action,
          );
        }
        pushConversation(
          "character",
          event.actor?.display_name ?? mapping.agent_character_name,
          event.dialogue || event.content,
        );
      } else if (event.event_type === "narration" || event.event_type === "scene_change") {
        pushConversation("narrator", "环境", event.content);
      }
    }
    for (const action of result.stage_actions) {
      pushConversation("command", "StageCommand", formatAgentAction(action));
    }
    if (activeRuntime !== runtime) {
      throw new Error("Agent 返回期间舞台已切换，请重新发送本轮消息");
    }
    activeRuntime.setControlOwner(mapping.stage_actor_id, "agent");
    for (const action of result.stage_actions) {
      const command = stageActionToCommand(action, nextCommandId("agent"));
      const commandResult = await activeRuntime.execute(command).completion;
      if (commandResult.status !== "completed") describeResult(commandResult);
    }
    agentStatus.value = "connected";
    agentStatusMessage.value = `第 ${result.turn_index} 轮完成 · ${result.stage_actions.length} 条舞台动作`;
  } catch (error) {
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
  }
}

function isAgentCharacterAvailable(mapping: CharacterAgentMappingEntry): boolean {
  return agentCharacters.value.length === 0 || agentCharacters.value.includes(mapping.agent_character_name);
}

function pushConversation(
  kind: ConversationLine["kind"],
  speaker: string,
  text: string,
): void {
  if (!text.trim()) return;
  conversationSequence += 1;
  conversation.value.push({
    id: `line-${conversationSequence}`,
    speaker,
    text: text.trim(),
    kind,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentApiError) {
    const detail = typeof error.detail === "string" ? `：${error.detail}` : "";
    return `Agent API ${error.status}${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatAgentAction(action: AgentStageAction): string {
  if (action.type === "actor.move_to") {
    return `move_to → ${action.anchor_id}${action.slot_id ? ` / ${action.slot_id}` : ""}`;
  }
  if (action.type === "actor.approach") {
    return `approach → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  }
  if (action.type === "actor.follow") {
    return `follow → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  }
  if (action.type === "actor.stop_follow") return "stop_follow";
  if (action.type === "actor.face") return `face → ${action.facing}`;
  if (action.type === "dialogue.say") return `say → ${action.text}`;
  return "stop";
}

function describeResult(result: CommandResult, success = "移动完成"): void {
  store.setMessage(
    result.status === "completed"
      ? success
      : `${result.status}: ${result.error?.message ?? "未知原因"}`,
  );
}

function actor(actorId: string): StageActorState | undefined {
  return store.snapshot?.actors.find((candidate) => candidate.actor_id === actorId);
}

function captureFollowBindings(activeRuntime: StageRuntime | null): FollowBinding[] {
  if (!activeRuntime) return [];
  return activeRuntime.snapshot().actors.flatMap((state) =>
    state.following_actor_id && state.follow_distance_tiles
      ? [{
          actorId: state.actor_id,
          targetActorId: state.following_actor_id,
          distanceTiles: state.follow_distance_tiles,
        }]
      : [],
  );
}

function nextCommandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${commandSequence}`;
}

async function loadScene(url: string): Promise<ScenePack> {
  return scenePackSchema.parse(await fetchJson(url));
}

async function loadActor(url: string): Promise<CharacterPack> {
  return characterPackSchema.parse(await fetchJson(url));
}

async function loadCharacterRegistry(url: string): Promise<CharacterRegistry> {
  return characterRegistrySchema.parse(await fetchJson(url));
}

async function loadCharacterMapping(url: string): Promise<CharacterAgentMapping> {
  return characterAgentMappingSchema.parse(await fetchJson(url));
}

async function loadStageRegistry(url: string): Promise<StageRegistry> {
  return stageRegistrySchema.parse(await fetchJson(url));
}

async function loadStage(url: string): Promise<StageDefinition> {
  return stageDefinitionSchema.parse(await fetchJson(url));
}

function contentUrl(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${import.meta.env.BASE_URL}${encoded}`;
}

function contentDirectoryUrl(path: string): string {
  return contentUrl(path.split("/").slice(0, -1).join("/"));
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  }
  return name.slice(0, 2);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 ${url} (${response.status})`);
  return response.json() as Promise<unknown>;
}

function formatEvent(event: (typeof store.events)[number]): string {
  const actorName =
    actorViews.value.find((view) => view.instanceId === event.actor_id)?.displayName ?? "stage";
  return `${String(event.sequence).padStart(2, "0")} · ${actorName} · ${event.type}`;
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand-block">
        <span class="eyebrow">UMA STAGE / PLAYABLE TEST</span>
        <h1>{{ stageName }}</h1>
      </div>
      <div class="status-block">
        <div class="stage-health" :class="store.phase">
          <span class="health-dot"></span>
          <span>{{ store.message }}</span>
        </div>
        <div class="service-badges">
          <span class="service-status" :class="agentStatus">AGENT · {{ agentStatus }}</span>
        </div>
      </div>
    </header>

    <section class="character-toolbar">
      <label>
        <span>出演角色</span>
        <select v-model="selectedCharacterId" :disabled="store.phase === 'loading' || agentStatus === 'connecting' || agentStatus === 'busy'" @change="changeCharacter">
          <option
            v-for="mapping in characterMappings"
            :key="mapping.character_id"
            :value="mapping.character_id"
            :disabled="!isAgentCharacterAvailable(mapping)"
          >
            {{ mapping.agent_character_name }}{{ isAgentCharacterAvailable(mapping) ? '' : '（Agent 未加载）' }}
          </option>
        </select>
      </label>
      <label>
        <span>服装</span>
        <select v-model="selectedOutfit" :disabled="store.phase === 'loading' || agentStatus === 'busy'" @change="changeOutfit">
          <option value="uniform">制服</option>
          <option value="race_outfit">决胜服</option>
        </select>
      </label>
      <span class="mapping-preview">
        {{ activeMapping?.character_id }} → {{ activeMapping?.stage_actor_id }}
      </span>
    </section>

    <section class="workspace">
      <div class="stage-card">
        <div class="stage-meta">
          <div>
            <span class="meta-label">PLAYABLE SLICE</span>
            <strong>角色加载 · 碰撞寻路 · Agent Stage Actions · Portal</strong>
          </div>
          <div class="key-guide" aria-label="移动操作">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            <span>移动训练员</span>
          </div>
        </div>
        <div ref="stageElement" class="stage-mount" :aria-label="`${stageName}舞台`">
          <div v-if="store.phase === 'loading'" class="loading-panel">LOADING STAGE…</div>
          <div v-if="store.phase === 'error'" class="error-panel">
            <strong>装载失败</strong>
            <span>{{ store.error }}</span>
            <button type="button" @click="() => initialize()">重试</button>
          </div>
        </div>
        <div class="action-dock">
          <div class="camera-actions" aria-label="镜头控制">
            <span>CAMERA</span>
            <button :disabled="store.phase !== 'ready' || !currentPlayerActorId" type="button" @click="followCamera(currentPlayerActorId)">跟随训练员</button>
            <button :disabled="store.phase !== 'ready'" type="button" @click="followCamera(activeActorId)">跟随角色</button>
            <button :disabled="store.phase !== 'ready'" type="button" @click="showCameraOverview">场景总览</button>
            <button v-for="zone in sceneZones.slice(0, 2)" :key="`camera-zone-${zone.id}`" :disabled="store.phase !== 'ready'" type="button" @click="focusCameraOnZone(zone.id)">
              定镜 · {{ zone.displayName }}
            </button>
            <button v-if="sceneZones.length === 0 && sceneAnchors[0]" :disabled="store.phase !== 'ready'" type="button" @click="focusCameraOnAnchor(sceneAnchors[0].id)">
              定镜 · {{ sceneAnchors[0].displayName }}
            </button>
          </div>
          <div class="actor-actions" aria-label="角色跟随控制">
            <span>ACTOR</span>
            <button :disabled="store.phase !== 'ready' || !currentPlayerActorId || activeActorFollowsPlayer" type="button" @click="startActorFollow">
              跟随训练员
            </button>
            <button :disabled="store.phase !== 'ready' || !activeActorFollowsPlayer" type="button" @click="stopActorFollow">
              停止跟随
            </button>
          </div>
          <button v-if="currentSceneId === 'tracen_student_plaza'" class="primary-action" :disabled="store.phase !== 'ready'" type="button" @click="runMeeting">
            <span>▶</span> 运行会面演出
          </button>
          <button v-for="anchor in sceneAnchors.slice(0, 3)" :key="anchor.id" :disabled="store.phase !== 'ready'" type="button" @click="sendActorTo(anchor.id, anchor.displayName)">
            {{ anchor.displayName }}
          </button>
          <button v-for="path in activityPaths" :key="path.id" :disabled="store.phase !== 'ready'" type="button" @click="runActivityPath(path.id, path.activityId)">
            执行 {{ path.activityId }}
          </button>
          <button type="button" @click="() => initialize()">重置场景</button>
          <button v-for="choice in stageChoices" :key="choice.stage_id" :class="{ 'stage-choice-active': choice.definition_path === activeStagePath }" :disabled="store.phase !== 'ready' || choice.definition_path === activeStagePath" type="button" @click="initialize(choice.definition_path)">
            {{ choice.display_name }}
          </button>
        </div>
      </div>

      <aside class="inspector">
        <section class="panel agent-panel">
          <div class="panel-heading">
            <span class="eyebrow">TRAINER ↔ ACTOR</span>
            <span class="agent-dot" :class="agentStatus"></span>
          </div>
          <div class="agent-session-summary">
            <strong>训练员 ↔ {{ activeCharacterName }}</strong>
            <span>连接与角色会话由 .env 自动初始化</span>
          </div>
          <div class="agent-status-row">
            <p class="agent-message">{{ agentStatusMessage }}</p>
            <button v-if="agentStatus === 'error' || agentStatus === 'disconnected'" type="button" @click="prepareAgentSession">重试</button>
          </div>
          <ol class="conversation-list">
            <li v-for="line in conversation" :key="line.id" :class="line.kind">
              <strong>{{ line.speaker }}</strong>
              <span>{{ line.text }}</span>
            </li>
            <li v-if="conversation.length === 0" class="conversation-empty">
              输入一句话，测试当前角色的对白、语言动作与舞台行为响应。
            </li>
          </ol>
          <form class="agent-compose" @submit.prevent="sendAgentMessage">
            <textarea v-model="agentInput" rows="2" :disabled="agentStatus === 'busy'" placeholder="例如：我们去喷泉旁聊聊吧。" @keydown.enter.exact.prevent="sendAgentMessage"></textarea>
            <button type="submit" :disabled="!agentInput.trim() || agentStatus === 'busy'">发送</button>
          </form>
        </section>

        <section class="panel actors-panel">
          <div class="panel-heading">
            <span class="eyebrow">LIVE ACTORS</span>
            <span class="count">{{ actorViews.length }} / {{ actorViews.length }}</span>
          </div>
          <article v-for="view in actorViews" :key="view.instanceId" class="actor-row">
            <div class="actor-index" :class="view.player ? 'trainer-index' : 'vega-index'">{{ view.initials }}</div>
            <div>
              <strong>{{ view.displayName }}</strong>
              <small>{{ actor(view.instanceId)?.control_owner ?? '—' }} · {{ actor(view.instanceId)?.locomotion ?? '—' }}/{{ actor(view.instanceId)?.facing ?? '—' }}</small>
            </div>
            <span class="coordinate">{{ actor(view.instanceId) ? `${Math.round(actor(view.instanceId)!.position.x)}, ${Math.round(actor(view.instanceId)!.position.y)}` : '—' }}</span>
          </article>
        </section>

        <section class="panel event-panel">
          <div class="panel-heading">
            <span class="eyebrow">STAGE EVENTS</span>
            <span class="live-mark">LIVE</span>
          </div>
          <ol class="event-list">
            <li v-for="event in [...store.events].reverse()" :key="event.sequence" :class="event.type.split('.')[0]">
              <span>{{ formatEvent(event) }}</span>
              <time>{{ (event.time_ms / 1000).toFixed(1) }}s</time>
            </li>
            <li v-if="store.events.length === 0" class="empty-event">等待舞台事件…</li>
          </ol>
        </section>
      </aside>
    </section>
  </main>
</template>
