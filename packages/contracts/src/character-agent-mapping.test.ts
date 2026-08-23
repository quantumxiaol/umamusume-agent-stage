import { describe, expect, it } from "vitest";

import { characterAgentMappingSchema } from "./character-agent-mapping";

const entry = {
  character_id: "admire_vega",
  agent_character_name: "爱慕织姬",
  stage_actor_id: "uma_admire_vega",
  uniform_bundle_id: "admire-vega-uniform",
  race_outfit_bundle_id: "admire-vega-race-outfit",
};

describe("characterAgentMappingSchema", () => {
  it("accepts the Agent-to-Stage identity boundary", () => {
    expect(
      characterAgentMappingSchema.parse({
        schema_version: "character_agent_mapping.v1",
        characters: [entry],
      }).characters[0],
    ).toEqual(entry);
  });

  it("rejects an actor id that does not match the stable character id", () => {
    expect(() =>
      characterAgentMappingSchema.parse({
        schema_version: "character_agent_mapping.v1",
        characters: [{ ...entry, stage_actor_id: "uma_other" }],
      }),
    ).toThrow(/stage_actor_id must be/u);
  });
});
