import { afterEach, describe, expect, it, vi } from "vitest";

import { performanceScriptSchema } from "@uma-stage/contracts";

import { audioDurationMs, performanceAudioPaths, PerformanceAudioPlayer } from "./performance-audio";

afterEach(() => vi.unstubAllGlobals());

class FakeSource extends EventTarget {
  buffer: unknown;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn(() => this.dispatchEvent(new Event("ended")));
}

function audioFixture() {
  const sources: FakeSource[] = [];
  const context = {
    state: "running", destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    suspend: vi.fn(async () => { context.state = "suspended"; }),
    decodeAudioData: vi.fn(async () => ({ duration: 2.4 })),
    createBufferSource: () => { const source = new FakeSource(); sources.push(source); return source; },
  };
  vi.stubGlobal("window", { AudioContext: class { constructor() { return context; } } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })));
  return { player: new PerformanceAudioPlayer((path) => path), context, sources };
}

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

  it("suspends and resumes audio without restarting a spoken line", async () => {
    const { player, context, sources } = audioFixture();
    const playback = await player.play("line.wav");
    await player.setPaused(true);
    expect(context.state).toBe("suspended");
    await player.unlock();
    expect(context.resume).not.toHaveBeenCalled();
    await player.setPaused(false);
    expect(context.state).toBe("running");
    expect(sources[0]?.start).toHaveBeenCalledOnce();
    player.stopAll();
    await playback.completion;
    expect(sources[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("does not start late audio after cancellation during decode", async () => {
    const { player, context, sources } = audioFixture();
    let finish!: (value: { duration: number }) => void;
    context.decodeAudioData.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const playback = player.play("late.wav", controller.signal);
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    player.stopAll();
    finish({ duration: 2.4 });
    await expect(playback).rejects.toThrow("cancelled");
    expect(sources).toHaveLength(0);
  });
});
