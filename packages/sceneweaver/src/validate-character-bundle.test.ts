import type { CharacterPack } from "@uma-stage/contracts";
import { describe, expect, it } from "vitest";

import { readPngSize, validateCharacterBundle } from "./validate-character-bundle";

const pack: CharacterPack = {
  schema_version: 1,
  actor_id: "test_actor",
  display_name: "Test Actor",
  outfit_id: "default",
  atlas: { image: "atlas.png", data: "atlas.json" },
  render: { frame_width: 64, frame_height: 64, anchor_x: 32, anchor_y: 61, scale: 1 },
  movement: { speed_px_per_second: 96, idle_after_ms: 800 },
  default_direction: "down",
  animations: {
    stand: {
      fps: 1,
      loop: false,
      fallback: null,
      directions: { down: ["down"], left: ["left"], right: ["right"], up: ["up"] },
    },
    walk: { fps: 8, loop: true, directions: {}, fallback: "stand" },
    idle: { fps: 2, loop: true, directions: { down: ["idle/down"] }, fallback: "stand" },
  },
};

function atlas(frame = { x: 0, y: 0, w: 64, h: 64 }): unknown {
  return {
    frames: Object.fromEntries(
      ["down", "left", "right", "up", "idle/down"].map((name) => [name, { frame }]),
    ),
    meta: { size: { w: 64, h: 64 } },
  };
}

describe("validateCharacterBundle", () => {
  it("accepts referenced frames inside the PNG", () => {
    expect(() => validateCharacterBundle(pack, atlas(), { width: 64, height: 64 })).not.toThrow();
  });

  it("rejects atlas rectangles outside the actual PNG", () => {
    expect(() =>
      validateCharacterBundle(pack, atlas({ x: 64, y: 0, w: 64, h: 64 }), {
        width: 64,
        height: 64,
      }),
    ).toThrow(/exceeds image bounds/);
  });

  it("reads dimensions from a PNG IHDR", () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 320);
    view.setUint32(20, 256);
    expect(readPngSize(bytes)).toEqual({ width: 320, height: 256 });
  });
});
