import { describe, expect, it, vi } from "vitest";

import {
  AgentApiClient,
  AgentApiError,
  AgentTimeoutError,
  reconcileStageTurnActions,
  stageActionToCommand,
} from "./index";

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

function stageCapabilitiesPayload() {
  return {
    schema_version: "agent_stage_api.v1",
    session_api: 1,
    turn_schema_version: "agent_stage_turn.v1",
    action_types: [...requiredStageActions],
    max_stage_actions_per_turn: 8,
  };
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

describe("AgentApiClient", () => {
  it("uses the API key and creates a stage session", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret");
      return new Response(
        JSON.stringify({
          session_id: "s1",
          user_uuid: "u1",
          participants: [
            {
              actor: {
                actor_id: "uma_admire_vega",
                actor_type: "umamusume",
                display_name: "爱慕织姬",
              },
            },
          ],
        }),
      );
    });
    const client = new AgentApiClient({ baseUrl: "https://agent.example/", apiKey: "secret", fetch });
    await expect(
      client.createStageSession({
        characterNames: ["爱慕织姬"],
        sceneName: "学生广场",
      }),
    ).resolves.toEqual({
      sessionId: "s1",
      userUuid: "u1",
      actors: [
        {
          actorId: "uma_admire_vega",
          actorType: "umamusume",
          displayName: "爱慕织姬",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/stage/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps external cancellation as AbortError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });
    const controller = new AbortController();
    const request = client.createStageSession(
      { characterNames: ["爱慕织姬"], sceneName: "学生广场" },
      controller.signal,
    );

    controller.abort();
    const error = await request.catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(AgentApiError);
    expect(error).not.toBeInstanceOf(AgentTimeoutError);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("uses a dedicated error when a request times out", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const client = new AgentApiClient({
      baseUrl: "https://agent.example",
      fetch,
      timeoutMs: 10,
    });

    const error = await client
      .listCharacters(new AbortController().signal)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect(error).toMatchObject({ name: "AgentTimeoutError", timeoutMs: 10 });
    expect(error).not.toBeInstanceOf(AgentApiError);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("preserves Retry-After on HTTP 429 errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        { detail: "Too many requests" },
        { status: 429, headers: { "Retry-After": "17" } },
      ),
    );
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    const error = await client.listCharacters().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentApiError);
    expect(error).toMatchObject({
      name: "AgentApiError",
      status: 429,
      detail: "Too many requests",
      retryAfter: "17",
    });
  });

  it("returns validated stage capabilities without requiring scene travel", async () => {
    const payload = stageCapabilitiesPayload();
    expect(payload.action_types).not.toContain("actor.travel_to_scene");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(payload));
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(
      client.stageCapabilities(new AbortController().signal),
    ).resolves.toEqual({
      schemaVersion: "agent_stage_api.v1",
      sessionApi: 1,
      turnSchemaVersion: "agent_stage_turn.v1",
      supportedActions: [...requiredStageActions],
      maxActionsPerTurn: 8,
    });
  });

  it.each([
    { field: "schema_version", value: "agent_stage_api.v2" },
    { field: "session_api", value: 2 },
    { field: "turn_schema_version", value: "agent_stage_turn.v2" },
    { field: "action_types", value: "actor.stop" },
    { field: "action_types", value: [...requiredStageActions, 3] },
    { field: "max_stage_actions_per_turn", value: 0 },
    { field: "max_stage_actions_per_turn", value: 1.5 },
  ])("rejects an invalid stage capability $field", async ({ field, value }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...stageCapabilitiesPayload(), [field]: value }),
    );
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.stageCapabilities()).rejects.toThrow(field);
  });

  it.each(requiredStageActions)("requires %s in stage capabilities", async (action) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        ...stageCapabilitiesPayload(),
        action_types: requiredStageActions.filter((candidate) => candidate !== action),
      }),
    );
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.stageCapabilities()).rejects.toThrow(action);
  });

  it("returns the Director participant limit from server capabilities", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ director_max_participants: 3 }),
    );
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(
      client.serverCapabilities(new AbortController().signal),
    ).resolves.toEqual({ directorMaxParticipants: 3 });
    expect(fetch).toHaveBeenCalledWith(
      "https://agent.example/capabilities",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { kind: "missing", payload: {} },
    { kind: "null", payload: { director_max_participants: null } },
  ])("returns null for a $kind Director participant limit", async ({ payload }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(payload));
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(client.serverCapabilities()).resolves.toEqual({
      directorMaxParticipants: null,
    });
  });

  it.each([0, -1, 1.5, "3"])(
    "rejects invalid Director participant limit %s",
    async (directorMaxParticipants) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse({ director_max_participants: directorMaxParticipants }),
      );
      const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

      await expect(client.serverCapabilities()).rejects.toThrow(
        "director_max_participants must be a positive integer",
      );
    },
  );
});

describe("stageActionToCommand", () => {
  it("maps an Agent anchor action to a validated StageCommand", () => {
    expect(
      stageActionToCommand(
        { type: "actor.move_to", actor_id: "uma_admire_vega", anchor_id: "fountain" },
        "agent-1",
      ),
    ).toEqual({
      id: "agent-1",
      type: "actor.move_to",
      actor_id: "uma_admire_vega",
      source: "agent",
      policy: "replace",
      target: { type: "anchor", id: "fountain" },
    });
  });

  it("maps an approach action to a live actor target", () => {
    expect(
      stageActionToCommand(
        {
          type: "actor.approach",
          actor_id: "uma_admire_vega",
          target_actor_id: "trainer",
          distance_tiles: 1,
        },
        "agent-2",
      ),
    ).toEqual({
      id: "agent-2",
      type: "actor.move_to",
      actor_id: "uma_admire_vega",
      source: "agent",
      policy: "replace",
      target: {
        type: "actor",
        id: "trainer",
        distance_tiles: 1,
        preferred_side: "above",
      },
    });
  });

  it("maps persistent follow controls without turning them into one-shot movement", () => {
    expect(
      stageActionToCommand(
        {
          type: "actor.follow",
          actor_id: "uma_admire_vega",
          target_actor_id: "trainer",
          distance_tiles: 2,
        },
        "agent-3",
      ),
    ).toEqual({
      id: "agent-3",
      type: "actor.follow",
      actor_id: "uma_admire_vega",
      target_actor_id: "trainer",
      distance_tiles: 2,
      preferred_side: "above",
      source: "agent",
      policy: "replace",
    });
    expect(
      stageActionToCommand(
        { type: "actor.stop_follow", actor_id: "uma_admire_vega" },
        "agent-4",
      ),
    ).toEqual({
      id: "agent-4",
      type: "actor.stop_follow",
      actor_id: "uma_admire_vega",
      source: "agent",
      policy: "replace",
    });
  });

  it("maps semantic actor-facing without calculating a direction in the client", () => {
    expect(
      stageActionToCommand(
        {
          type: "actor.face_actor",
          actor_id: "uma_admire_vega",
          target_actor_id: "trainer",
        },
        "agent-face",
      ),
    ).toEqual({
      id: "agent-face",
      type: "actor.face_actor",
      actor_id: "uma_admire_vega",
      target_actor_id: "trainer",
      source: "agent",
      policy: "replace",
    });
  });

  it("accepts a Director request for one actor to travel to another scene", async () => {
    const response = {
      schema_version: "agent_stage_turn.v1" as const,
      session_id: "s1",
      turn_index: 2,
      events: [],
      stage_actions: [{
        type: "actor.travel_to_scene" as const,
        actor_id: "uma_admire_vega",
        target_scene_id: "tracen_training_ground",
        target_spawn_id: "from_student_plaza",
      }],
      scene_state: {},
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify(response)),
    );
    const client = new AgentApiClient({ baseUrl: "https://agent.example", fetch });

    await expect(
      client.turn(
        {
          sessionId: "s1",
          userUuid: "u1",
          message: "先去训练场等我。",
          targetActorIds: ["agent-admire-vega"],
          actorBindings: [
            {
              agent_actor_id: "agent-admire-vega",
              stage_actor_id: "uma_admire_vega",
            },
          ],
          liveStage: {
            schema_version: "live_stage.v1",
            stage_id: "student_plaza_stage",
            scene_id: "tracen_student_plaza",
            actors: [],
            remote_actors: [],
            travel_destinations: [],
            anchors: [],
            activity_paths: [],
            portals: [],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ stage_actions: response.stage_actions });
  });
});

describe("reconcileStageTurnActions", () => {
  const reply = {
    event_id: "event-1",
    sequence: 1,
    event_type: "character_reply",
    content: "嗯，走吧。",
    dialogue: "嗯，走吧。",
    action: "轻轻点头",
    actor: {
      actor_id: "agent-admire-vega",
      display_name: "爱慕织姬",
    },
  };
  const bindings = [
    {
      agent_actor_id: "agent-admire-vega",
      stage_actor_id: "uma_admire_vega",
    },
  ];

  it("adds a speech action when an older Agent response only contains the reply event", () => {
    expect(
      reconcileStageTurnActions(
        {
          events: [reply],
          stage_actions: [
            {
              type: "actor.approach",
              actor_id: "uma_admire_vega",
              target_actor_id: "trainer",
              distance_tiles: 1,
              preferred_side: "above",
            },
          ],
        },
        bindings,
      ),
    ).toEqual([
      {
        type: "actor.approach",
        actor_id: "uma_admire_vega",
        target_actor_id: "trainer",
        distance_tiles: 1,
        preferred_side: "above",
      },
      {
        type: "dialogue.say",
        actor_id: "uma_admire_vega",
        text: "嗯，走吧。",
      },
    ]);
  });

  it("does not duplicate speech already appended by StageSceneService", () => {
    const speech = {
      type: "dialogue.say" as const,
      actor_id: "uma_admire_vega",
      text: "嗯，走吧。",
    };
    expect(
      reconcileStageTurnActions(
        { events: [reply], stage_actions: [speech] },
        bindings,
      ),
    ).toEqual([speech]);
  });
});
