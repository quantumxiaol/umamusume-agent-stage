import { describe, expect, it } from "vitest";

import { performanceScriptSchema } from "./performance-script";

const script = {
  schema_version: "performance_script.v1",
  performance_id: "meeting_demo",
  title: "Meeting Demo",
  cast: [
    { role_id: "trainer", character_id: "trainer", outfit_id: "default" },
    { role_id: "vega", character_id: "admire_vega" },
  ],
  scenes: [
    {
      scene_id: "plaza",
      stage_id: "student_plaza_stage",
      placements: [{ role_id: "trainer", spawn_id: "trainer_start" }],
      beats: [
        {
          beat_id: "approach",
          cues: [
            {
              cue_id: "vega_approaches",
              type: "actor.move_to",
              role_id: "vega",
              target: { type: "actor", role_id: "trainer" },
            },
            {
              cue_id: "camera_follows",
              type: "camera.follow_actor",
              role_id: "vega",
            },
          ],
        },
      ],
    },
  ],
} as const;

describe("performanceScriptSchema", () => {
  it("parses a role-based parallel beat", () => {
    const parsed = performanceScriptSchema.parse(script);
    expect(parsed.scenes[0]?.beats[0]).toMatchObject({
      wait_for: "all",
      hold_ms: 0,
      cues: [
        {
          target: {
            preferred_side: "above",
          },
        },
        {},
      ],
    });
  });

  it("rejects references to roles outside the cast", () => {
    const invalid = structuredClone(script) as Record<string, any>;
    invalid.scenes[0].beats[0].cues[0].target.role_id = "unknown";
    expect(() => performanceScriptSchema.parse(invalid)).toThrow("unknown role_id");
  });
});
