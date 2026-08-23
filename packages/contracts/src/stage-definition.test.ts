import { describe, expect, it } from "vitest";

import { stageDefinitionSchema } from "./stage-definition";

describe("stageDefinitionSchema", () => {
  it("rejects duplicate actor instances", () => {
    expect(() =>
      stageDefinitionSchema.parse({
        schema_version: "stage_definition.v1",
        stage_id: "demo",
        display_name: "Demo",
        scene_path: "scenes/demo/scene.json",
        actors: [
          { instance_id: "actor", bundle_id: "a", spawn_id: "one", control_owner: "agent" },
          { instance_id: "actor", bundle_id: "b", spawn_id: "two", control_owner: "agent" },
        ],
      }),
    ).toThrow(/duplicate instance_id/);
  });
});
