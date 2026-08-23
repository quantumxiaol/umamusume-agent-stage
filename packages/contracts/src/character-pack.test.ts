import { describe, expect, it } from "vitest";

import { base20CharacterPackSchema } from "./character-pack";

function base20Pack(): unknown {
  const directions = ["down", "left", "right", "up"] as const;
  return {
    schema_version: 1,
    actor_id: "test_actor",
    display_name: "Test Actor",
    outfit_id: "uniform",
    atlas: { image: "atlas.png", data: "atlas.json" },
    render: { frame_width: 64, frame_height: 64, anchor_x: 32, anchor_y: 61, scale: 3 },
    movement: { speed_px_per_second: 96, idle_after_ms: 800 },
    default_direction: "down",
    animations: {
      stand: {
        fps: 1,
        loop: false,
        fallback: null,
        directions: Object.fromEntries(directions.map((direction) => [direction, [`stand/${direction}/000`]])),
      },
      walk: {
        fps: 8,
        loop: true,
        fallback: null,
        directions: Object.fromEntries(
          directions.map((direction) => [direction, [`walk/${direction}/000`, `walk/${direction}/001`]]),
        ),
      },
      idle: {
        fps: 2,
        loop: true,
        fallback: null,
        directions: Object.fromEntries(
          directions.map((direction) => [direction, [`idle/${direction}/000`, `idle/${direction}/001`]]),
        ),
      },
    },
  };
}

describe("base20CharacterPackSchema", () => {
  it("accepts 4 stand, 8 walk and 8 idle frames", () => {
    expect(base20CharacterPackSchema.parse(base20Pack())).toBeTruthy();
  });

  it("rejects missing directional frames and fallbacks", () => {
    const pack = base20Pack() as {
      animations: {
        idle: { directions: Record<string, string[]>; fallback: string | null };
      };
    };
    pack.animations.idle.directions.left = [];
    pack.animations.idle.fallback = "stand";
    expect(() => base20CharacterPackSchema.parse(pack)).toThrow(/base20/);
  });
});
