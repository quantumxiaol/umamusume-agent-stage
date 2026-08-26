import { describe, expect, it, vi } from "vitest";

import {
  AgentApiClient,
  reconcileStageTurnActions,
  stageActionToCommand,
} from "./index";

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
      target: { type: "actor", id: "trainer", distance_tiles: 1 },
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

    await expect(client.turn({
      sessionId: "s1",
      userUuid: "u1",
      message: "先去训练场等我。",
      targetActorIds: ["agent-admire-vega"],
      actorBindings: [{
        agent_actor_id: "agent-admire-vega",
        stage_actor_id: "uma_admire_vega",
      }],
      liveStage: {
        schema_version: "live_stage.v1",
        stage_id: "student_plaza_stage",
        scene_id: "tracen_student_plaza",
        actors: [],
        anchors: [],
        activity_paths: [],
        portals: [],
      },
    })).resolves.toMatchObject({ stage_actions: response.stage_actions });
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
