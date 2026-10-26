import {
  agentCharacterListSchema,
  agentStageSessionResponseSchema,
  agentStageTurnResponseSchema,
  stageCommandSchema,
  type AgentLiveStage,
  type AgentStageAction,
  type AgentStageActionInput,
  type AgentStageActorBinding,
  type AgentStageEvent,
  type AgentStageTurnResponse,
  type StageCommand,
} from "@uma-stage/contracts";

export interface AgentClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface CreateStageSessionInput {
  characterNames: string[];
  sceneName: string;
  userUuid?: string;
  storyOutline?: string;
  templateId?: string;
}

export interface StageTurnInput {
  sessionId: string;
  userUuid: string;
  message: string;
  targetActorIds: string[];
  actorBindings: AgentStageActorBinding[];
  liveStage: AgentLiveStage;
}

export interface AgentStageCapabilities {
  schemaVersion: "agent_stage_api.v1";
  sessionApi: 1;
  turnSchemaVersion: "agent_stage_turn.v1";
  supportedActions: string[];
  maxActionsPerTurn: number;
}

export interface ServerCapabilities {
  directorMaxParticipants: number | null;
}

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export class AgentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent API request timed out after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

const requiredStageActions = [
  "actor.move_to",
  "actor.approach",
  "actor.follow",
  "actor.stop_follow",
  "actor.stop",
  "actor.face",
  "actor.face_actor",
  "dialogue.say",
] as const;

export class AgentApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  #apiKey: string;

  constructor(options: AgentClientOptions) {
    this.#baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (!this.#baseUrl) throw new Error("Agent base URL is required");
    this.#apiKey = options.apiKey?.trim() ?? "";
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 90_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Agent timeoutMs must be a positive finite number");
    }
  }

  setApiKey(apiKey: string): void {
    this.#apiKey = apiKey.trim();
  }

  async listCharacters(signal?: AbortSignal): Promise<string[]> {
    const response = agentCharacterListSchema.parse(await this.#request("/characters", {}, signal));
    return response.characters;
  }

  async stageCapabilities(signal?: AbortSignal): Promise<AgentStageCapabilities> {
    return parseStageCapabilities(await this.#request("/stage/capabilities", {}, signal));
  }

  async serverCapabilities(signal?: AbortSignal): Promise<ServerCapabilities> {
    const payload = await this.#request("/capabilities", {}, signal);
    if (!isRecord(payload)) {
      throw new Error("Invalid Agent server capabilities response: expected an object");
    }
    const directorMaxParticipants = payload.director_max_participants;
    if (directorMaxParticipants === undefined || directorMaxParticipants === null) {
      return { directorMaxParticipants: null };
    }
    if (
      typeof directorMaxParticipants !== "number" ||
      !Number.isInteger(directorMaxParticipants) ||
      directorMaxParticipants <= 0
    ) {
      throw new Error(
        "Invalid Agent server capabilities response: director_max_participants must be a positive integer",
      );
    }
    return { directorMaxParticipants };
  }

  async createStageSession(
    input: CreateStageSessionInput,
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string;
    userUuid: string;
    actors: Array<{ actorId: string; displayName: string; actorType: string }>;
  }> {
    const response = agentStageSessionResponseSchema.parse(
      await this.#request(
        "/stage/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            character_names: input.characterNames,
            story_outline: input.storyOutline ?? "",
            ...(input.templateId
              ? { template_id: input.templateId }
              : {
                  custom_scene: {
                    name: input.sceneName,
                    initial_state: {
                      location: "特雷森学院",
                      sub_location: input.sceneName,
                    },
                  },
                }),
            ...(input.userUuid ? { user_uuid: input.userUuid } : {}),
          }),
        },
        signal,
      ),
    );
    return {
      sessionId: response.session_id,
      userUuid: response.user_uuid,
      actors: response.participants.map((participant) => ({
        actorId: participant.actor.actor_id,
        displayName: participant.actor.display_name,
        actorType: participant.actor.actor_type,
      })),
    };
  }

  async turn(input: StageTurnInput, signal?: AbortSignal): Promise<AgentStageTurnResponse> {
    return agentStageTurnResponseSchema.parse(
      await this.#request(
        "/stage/turn",
        {
          method: "POST",
          body: JSON.stringify({
            session_id: input.sessionId,
            user_uuid: input.userUuid,
            events: [
              {
                content: input.message,
                event_type: "dialogue",
                speaker: {
                  actor_id: "player",
                  actor_type: "trainer",
                  display_name: "训练员",
                  role_in_scene: "trainer",
                },
                target_actor_ids: input.targetActorIds,
              },
            ],
            actor_bindings: input.actorBindings,
            live_stage: input.liveStage,
            generate_voice: false,
          }),
        },
        signal,
      ),
    );
  }

  async #request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.#apiKey) headers.set("X-API-Key", this.#apiKey);
    if (signal?.aborted) throw toAbortError(signal.reason);

    const controller = new AbortController();
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const onExternalAbort = () => {
      const error = toAbortError(signal?.reason);
      rejectCancellation(error);
      controller.abort(error);
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      const error = new AgentTimeoutError(this.#timeoutMs);
      rejectCancellation(error);
      controller.abort(error);
    }, this.#timeoutMs);

    const request = async (): Promise<unknown> => {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        const detail =
          payload && typeof payload === "object" && "detail" in payload
            ? (payload as { detail: unknown }).detail
            : payload;
        const retryAfter =
          response.status === 429 ? (response.headers.get("Retry-After") ?? undefined) : undefined;
        throw new AgentApiError(
          `Agent API request failed (${response.status})`,
          response.status,
          detail,
          retryAfter,
        );
      }
      return payload;
    };

    try {
      return await Promise.race([request(), cancellation]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function stageActionToCommand(
  action: Exclude<AgentStageActionInput, { type: "actor.travel_to_scene" }>,
  commandId: string,
): StageCommand {
  const base = {
    id: commandId,
    actor_id: action.actor_id,
    source: "agent" as const,
    policy: "replace" as const,
  };
  if (action.type === "actor.move_to") {
    return stageCommandSchema.parse({
      ...base,
      type: action.type,
      target: {
        type: "anchor",
        id: action.anchor_id,
        ...(action.slot_id ? { slot_id: action.slot_id } : {}),
      },
    });
  }
  if (action.type === "actor.face") {
    return stageCommandSchema.parse({ ...base, type: action.type, facing: action.facing });
  }
  if (action.type === "actor.face_actor") {
    return stageCommandSchema.parse({
      ...base,
      type: action.type,
      target_actor_id: action.target_actor_id,
    });
  }
  if (action.type === "actor.approach") {
    return stageCommandSchema.parse({
      ...base,
      type: "actor.move_to",
      target: {
        type: "actor",
        id: action.target_actor_id,
        distance_tiles: action.distance_tiles,
        preferred_side: action.preferred_side ?? "above",
      },
    });
  }
  if (action.type === "actor.follow") {
    return stageCommandSchema.parse({
      ...base,
      type: action.type,
      target_actor_id: action.target_actor_id,
      distance_tiles: action.distance_tiles,
      preferred_side: action.preferred_side ?? "above",
    });
  }
  if (action.type === "actor.stop_follow") {
    return stageCommandSchema.parse({ ...base, type: action.type });
  }
  if (action.type === "dialogue.say") {
    return stageCommandSchema.parse({ ...base, type: action.type, text: action.text });
  }
  return stageCommandSchema.parse({ ...base, type: action.type });
}

/**
 * Keep live roleplay playable across Agent deployments that do or do not
 * already append dialogue.say actions for character replies.
 *
 * StageSceneService currently supplies these actions server-side. The client
 * still reconciles the response because a visible reply without a speech
 * command would otherwise silently disappear from the stage.
 */
export function reconcileStageTurnActions(
  response: Pick<AgentStageTurnResponse, "events" | "stage_actions">,
  actorBindings: AgentStageActorBinding[],
): AgentStageAction[] {
  const stageActorByAgentActor = new Map(
    actorBindings.map((binding) => [binding.agent_actor_id, binding.stage_actor_id]),
  );
  const actions = [...response.stage_actions];
  const availableDialogueActions = countDialogueActions(actions);

  for (const event of response.events) {
    const fallback = replyToDialogueAction(event, stageActorByAgentActor);
    if (!fallback) continue;
    const key = dialogueActionKey(fallback.actor_id, fallback.text);
    const available = availableDialogueActions.get(key) ?? 0;
    if (available > 0) {
      availableDialogueActions.set(key, available - 1);
      continue;
    }
    actions.push(fallback);
  }
  return actions;
}

function replyToDialogueAction(
  event: AgentStageEvent,
  stageActorByAgentActor: Map<string, string>,
): Extract<AgentStageAction, { type: "dialogue.say" }> | null {
  if (event.event_type !== "character_reply" || !event.actor) return null;
  const text = event.dialogue.trim() || event.content.trim();
  if (!text) return null;
  const actorId = stageActorByAgentActor.get(event.actor.actor_id);
  if (!actorId) return null;
  return { type: "dialogue.say", actor_id: actorId, text };
}

function countDialogueActions(actions: AgentStageAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    if (action.type !== "dialogue.say") continue;
    const key = dialogueActionKey(action.actor_id, action.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function dialogueActionKey(actorId: string, text: string): string {
  return `${actorId}\u0000${text.trim()}`;
}

function parseStageCapabilities(payload: unknown): AgentStageCapabilities {
  if (!isRecord(payload)) {
    throw new Error("Invalid Agent stage capabilities response: expected an object");
  }
  if (payload.schema_version !== "agent_stage_api.v1") {
    throw new Error(
      'Invalid Agent stage capabilities response: schema_version must be "agent_stage_api.v1"',
    );
  }
  if (payload.session_api !== 1) {
    throw new Error("Invalid Agent stage capabilities response: session_api must be 1");
  }
  if (payload.turn_schema_version !== "agent_stage_turn.v1") {
    throw new Error(
      'Invalid Agent stage capabilities response: turn_schema_version must be "agent_stage_turn.v1"',
    );
  }
  const supportedActions = payload.action_types;
  if (!isNonEmptyStringArray(supportedActions)) {
    throw new Error(
      "Invalid Agent stage capabilities response: action_types must be an array of non-empty strings",
    );
  }
  const maxActionsPerTurn = payload.max_stage_actions_per_turn;
  if (
    typeof maxActionsPerTurn !== "number" ||
    !Number.isInteger(maxActionsPerTurn) ||
    maxActionsPerTurn <= 0
  ) {
    throw new Error(
      "Invalid Agent stage capabilities response: max_stage_actions_per_turn must be a positive integer",
    );
  }
  const missingActions = requiredStageActions.filter(
    (action) => !supportedActions.includes(action),
  );
  if (missingActions.length > 0) {
    throw new Error(
      `Agent stage capabilities are missing required action_types: ${missingActions.join(", ")}`,
    );
  }
  return {
    schemaVersion: "agent_stage_api.v1",
    sessionApi: 1,
    turnSchemaVersion: "agent_stage_turn.v1",
    supportedActions: [...supportedActions],
    maxActionsPerTurn,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("Agent API request was aborted", "AbortError");
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
