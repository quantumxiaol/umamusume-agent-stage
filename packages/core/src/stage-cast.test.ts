import { describe, expect, it } from "vitest";

import {
  characterAgentMappingEntrySchema,
  stageDefinitionSchema,
} from "@uma-stage/contracts";

import { applyStageCast } from "./stage-cast";

const stage = stageDefinitionSchema.parse({
  schema_version: "stage_definition.v1",
  stage_id: "cast_test",
  display_name: "Cast Test",
  scene_path: "scenes/cast-test/scene.json",
  actors: [
    {
      instance_id: "trainer",
      bundle_id: "trainer",
      spawn_id: "trainer",
      control_owner: "player",
      player: true,
    },
    {
      instance_id: "placeholder",
      bundle_id: "placeholder",
      spawn_id: "cast",
      control_owner: "agent",
    },
  ],
});

function mapping(characterId: string) {
  return characterAgentMappingEntrySchema.parse({
    character_id: characterId,
    agent_character_name: characterId,
    stage_actor_id: `uma_${characterId}`,
    uniform_bundle_id: `${characterId}-uniform`,
    race_outfit_bundle_id: `${characterId}-race-outfit`,
  });
}

describe("applyStageCast", () => {
  it("expands one agent placeholder into a multi-character cast", () => {
    const result = applyStageCast(stage, [
      { mapping: mapping("alpha"), outfit: "uniform" },
      { mapping: mapping("beta"), outfit: "race_outfit" },
    ]);

    expect(result.actors).toMatchObject([
      { instance_id: "trainer", control_owner: "player" },
      {
        instance_id: "uma_alpha",
        bundle_id: "alpha-uniform",
        spawn_id: "cast",
        control_owner: "agent",
      },
      {
        instance_id: "uma_beta",
        bundle_id: "beta-race-outfit",
        spawn_id: "cast",
        control_owner: "agent",
      },
    ]);
  });

  it("rejects duplicate cast identities", () => {
    const alpha = mapping("alpha");
    expect(() =>
      applyStageCast(stage, [
        { mapping: alpha, outfit: "uniform" },
        { mapping: alpha, outfit: "race_outfit" },
      ]),
    ).toThrow("Duplicate cast character");
  });
});
