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

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export class AgentApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  #apiKey: string;

  constructor(options: AgentClientOptions) {
    this.#baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    if (!this.#baseUrl) throw new Error("Agent base URL is required");
    this.#apiKey = options.apiKey?.trim() ?? "";
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setApiKey(apiKey: string): void {
    this.#apiKey = apiKey.trim();
  }

  async listCharacters(): Promise<string[]> {
    const response = agentCharacterListSchema.parse(await this.#request("/characters"));
    return response.characters;
  }

  async stageCapabilities(): Promise<Record<string, unknown>> {
    const payload = await this.#request("/stage/capabilities");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid Agent stage capabilities response");
    }
    return payload as Record<string, unknown>;
  }

  async createStageSession(input: CreateStageSessionInput): Promise<{
    sessionId: string;
    userUuid: string;
    actors: Array<{ actorId: string; displayName: string; actorType: string }>;
  }> {
    const response = agentStageSessionResponseSchema.parse(
      await this.#request("/stage/sessions", {
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
      }),
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

  async turn(input: StageTurnInput): Promise<AgentStageTurnResponse> {
    return agentStageTurnResponseSchema.parse(
      await this.#request("/stage/turn", {
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
      }),
    );
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.#apiKey) headers.set("X-API-Key", this.#apiKey);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    const payload = await readPayload(response);
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "detail" in payload
          ? (payload as { detail: unknown }).detail
          : payload;
      throw new AgentApiError(`Agent API request failed (${response.status})`, response.status, detail);
    }
    return payload;
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

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
