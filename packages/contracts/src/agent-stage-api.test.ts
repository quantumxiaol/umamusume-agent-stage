import { describe, expect, it } from "vitest";

import {
  agentLiveStageSchema,
  agentStageActionSchema,
  agentStageActorBindingSchema,
} from "./agent-stage-api";

const liveStage = {
  schema_version: "live_stage.v1" as const,
  stage_id: "stage-1",
  scene_id: "scene-1",
  actors: [],
  anchors: [],
  activity_paths: [],
  portals: [],
};

describe("agentStageActorBindingSchema", () => {
  it("accepts an optional scene identity for cross-scene bindings", () => {
    expect(agentStageActorBindingSchema.parse({
      agent_actor_id: "agent-1",
      stage_actor_id: "actor-1",
    })).toEqual({
      agent_actor_id: "agent-1",
      stage_actor_id: "actor-1",
    });
    expect(agentStageActorBindingSchema.parse({
      agent_actor_id: "agent-1",
      stage_actor_id: "actor-1",
      scene_id: "scene-2",
    })).toMatchObject({ scene_id: "scene-2" });
  });
});

describe("agentLiveStageSchema", () => {
  it("keeps live_stage.v1 additive with empty remote metadata defaults", () => {
    expect(agentLiveStageSchema.parse(liveStage)).toEqual({
      ...liveStage,
      remote_actors: [],
      travel_destinations: [],
    });
  });

  it("parses remote actors and destination defaults", () => {
    expect(agentLiveStageSchema.parse({
      ...liveStage,
      remote_actors: [{ actor_id: "actor-2", scene_id: "scene-2" }],
      travel_destinations: [{ scene_id: "scene-2" }],
    })).toMatchObject({
      remote_actors: [{ actor_id: "actor-2", scene_id: "scene-2" }],
      travel_destinations: [{ scene_id: "scene-2", display_name: "", spawn_ids: [] }],
    });
  });

  it("retains the scene travel action", () => {
    expect(agentStageActionSchema.parse({
      type: "actor.travel_to_scene",
      actor_id: "actor-1",
      target_scene_id: "scene-2",
    })).toEqual({
      type: "actor.travel_to_scene",
      actor_id: "actor-1",
      target_scene_id: "scene-2",
    });
  });
});
