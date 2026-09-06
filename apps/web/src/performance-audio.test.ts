import { describe, expect, it } from "vitest";

import { performanceScriptSchema } from "@uma-stage/contracts";

import { audioDurationMs, performanceAudioPaths } from "./performance-audio";

describe("performance audio", () => {
  it("collects unique speech assets in first-use order", () => {
    const script = performanceScriptSchema.parse({
      schema_version: "performance_script.v1",
      performance_id: "audio_demo",
      title: "音频演出",
      cast: [{ role_id: "vega", character_id: "admire_vega" }],
      scenes: [{
        scene_id: "scene",
        stage_id: "stage",
        beats: [{
          beat_id: "lines",
          cues: [
            {
              cue_id: "line_1",
              type: "dialogue.say",
              role_id: "vega",
              text: "第一句",
              audio_path: "draft/audio/line-1.wav",
            },
            { cue_id: "pause", type: "stage.wait", duration_ms: 100 },
            {
              cue_id: "line_2",
              type: "narration.say",
              text: "旁白",
              audio_path: "draft/audio/line-2.wav",
            },
            {
              cue_id: "line_1_again",
              type: "dialogue.say",
              role_id: "vega",
              text: "重复音频",
              audio_path: "draft/audio/line-1.wav",
            },
          ],
        }],
      }],
    });

    expect(performanceAudioPaths(script)).toEqual([
      "draft/audio/line-1.wav",
      "draft/audio/line-2.wav",
    ]);
  });

  it("rounds decoded duration up to a positive millisecond duration", () => {
    expect(audioDurationMs(2.400_001)).toBe(2401);
    expect(audioDurationMs(0)).toBe(1);
  });
});
