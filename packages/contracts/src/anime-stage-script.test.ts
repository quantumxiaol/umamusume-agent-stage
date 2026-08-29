import { describe, expect, it } from "vitest";

import { animeStageScriptSchema } from "./anime-stage-script";

const script = {
  projectId: "Anime_Project",
  title: "兼容剧本",
  lines: [
    {
      id: "vo001",
      type: "narration",
      speakerId: "Voice-over",
      background: "observatory_night",
      spokenText: "星空很安静。",
      subtitleZh: "星空很安静。",
    },
    {
      id: "av001",
      type: "dialogue",
      speakerId: "admire_vega",
      background: "observatory_night",
      spokenText: "星が見える。",
      subtitleZh: "能看见星星。",
    },
  ],
  stage: {
    schema_version: "anime_stage.v1",
    performance_id: "anime_compatible_demo",
    cast: [
      {
        anime_speaker_id: "admire_vega",
        role_id: "admire_vega",
        character_id: "admire_vega",
      },
    ],
    scenes: [
      {
        scene_id: "observatory",
        stage_id: "observatory_stage",
        backgrounds: ["observatory_night"],
        environment: { time_of_day: "night" },
      },
    ],
    directions: {
      av001: {
        during: [
          {
            cue_id: "focus_vega",
            type: "camera.focus_actor",
            role_id: "admire_vega",
          },
        ],
      },
    },
  },
} as const;

describe("animeStageScriptSchema", () => {
  it("parses original anime dialogue fields plus one Stage extension", () => {
    const parsed = animeStageScriptSchema.parse(script);
    expect(parsed.stage).toMatchObject({
      line_gap_ms: 150,
      cast: [{ outfit_id: "uniform" }],
      scenes: [
        {
          placements: [],
          environment: {
            schema_version: "stage_environment.v1",
            time_of_day: "night",
            weather: "clear",
          },
        },
      ],
    });
    expect(parsed.lines[1]).toMatchObject({
      speakerId: "admire_vega",
      spokenText: "星が見える。",
      subtitleZh: "能看见星星。",
    });
  });

  it("rejects dialogue and backgrounds that cannot be represented on Stage", () => {
    const invalid = structuredClone(script) as Record<string, any>;
    invalid.lines[1].speakerId = "unknown";
    invalid.lines[1].background = "unknown_background";
    expect(() => animeStageScriptSchema.parse(invalid)).toThrow(
      /no Stage cast mapping|no Stage scene mapping/,
    );
  });
});
