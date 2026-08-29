import { animeStageScriptSchema } from "@uma-stage/contracts";
import { describe, expect, it } from "vitest";

import { compileAnimeStageScript } from "./anime-stage-adapter";

describe("compileAnimeStageScript", () => {
  it("turns anime lines and per-line directions into ordered Performance beats", () => {
    const source = animeStageScriptSchema.parse({
      projectId: "Anime_Project",
      title: "星空会面",
      source: "draft/example.md",
      lines: [
        {
          id: "vo001",
          type: "narration",
          speakerId: "Voice-over",
          background: "observatory_night",
          audio: "draft/audio/vo001.wav",
          spokenText: "星空很安静。",
          subtitleZh: "星空很安静。",
        },
        {
          id: "av001",
          type: "dialogue",
          speakerId: "admire_vega",
          speakerLabel: "爱慕织姬",
          background: "observatory_night",
          audio: "draft/audio/av001.wav",
          spokenText: "星が見える。",
          subtitleJa: "星が見える。",
          subtitleZh: "能看见星星。",
        },
      ],
      stage: {
        schema_version: "anime_stage.v1",
        performance_id: "starlight_meeting",
        line_gap_ms: 90,
        cast: [
          {
            anime_speaker_id: "admire_vega",
            role_id: "vega",
            character_id: "admire_vega",
            display_name: "爱慕织姬",
            outfit_id: "uniform",
          },
        ],
        scenes: [
          {
            scene_id: "observatory",
            stage_id: "observatory_stage",
            backgrounds: ["observatory_night"],
            environment: { time_of_day: "night", transition_ms: 0 },
          },
        ],
        directions: {
          av001: {
            before: [
              {
                cue_id: "vega_faces_trainer",
                type: "actor.face",
                role_id: "vega",
                facing: "down",
              },
            ],
            during: [
              {
                cue_id: "focus_vega",
                type: "camera.focus_actor",
                role_id: "vega",
              },
            ],
            duration_ms: 1200,
          },
        },
      },
    });

    const performance = compileAnimeStageScript(source);
    expect(performance).toMatchObject({
      schema_version: "performance_script.v1",
      performance_id: "starlight_meeting",
      cast: [{ role_id: "vega", character_id: "admire_vega" }],
      scenes: [
        {
          scene_id: "observatory",
          stage_id: "observatory_stage",
          environment: { time_of_day: "night", transition_ms: 0 },
        },
      ],
    });
    expect(performance.scenes[0]?.beats.map((beat) => beat.beat_id)).toEqual([
      "vo001_line",
      "av001_before",
      "av001_line",
    ]);
    expect(performance.scenes[0]?.beats[2]).toMatchObject({
      hold_ms: 90,
      cues: [
        { type: "camera.focus_actor", role_id: "vega" },
        {
          type: "dialogue.say",
          role_id: "vega",
          text: "能看见星星。",
          spoken_text: "星が見える。",
          subtitle_ja: "星が見える。",
          subtitle_zh: "能看见星星。",
          audio_path: "draft/audio/av001.wav",
          duration_ms: 1200,
        },
      ],
    });
  });
});
