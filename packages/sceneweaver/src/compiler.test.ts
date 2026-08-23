import { describe, expect, it } from "vitest";

import { compileTiledScene } from "./compiler";
import type { TiledMap } from "./tiled-types";

function fixture(): TiledMap {
  return {
    width: 6,
    height: 5,
    tilewidth: 32,
    tileheight: 32,
    orientation: "orthogonal",
    layers: [
      {
        name: "collision",
        type: "objectgroup",
        objects: [{ id: 1, name: "wall", x: 64, y: 32, width: 32, height: 64 }],
      },
      {
        name: "anchors",
        type: "objectgroup",
        objects: [{ id: 2, name: "meeting", point: true, x: 128, y: 64 }],
      },
      {
        name: "anchor_slots",
        type: "objectgroup",
        objects: [
          {
            id: 3,
            name: "left",
            point: true,
            x: 96,
            y: 64,
            properties: [{ name: "anchor_id", value: "meeting" }],
          },
        ],
      },
      {
        name: "spawn_points",
        type: "objectgroup",
        objects: [{ id: 4, name: "trainer_start", point: true, x: 32, y: 32 }],
      },
    ],
  };
}

describe("compileTiledScene", () => {
  it("rasterizes collision and attaches named anchor slots", () => {
    const scene = compileTiledScene(fixture(), {
      sceneId: "test_scene",
      displayName: "Test Scene",
    });

    expect(scene.navigation.blocked_tiles).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(scene.anchors[0]?.slots).toEqual([{ id: "left", position: { x: 3, y: 2 } }]);
  });

  it("rejects slots that land on collision", () => {
    const map = fixture();
    const slots = map.layers.find((layer) => layer.name === "anchor_slots");
    if (slots?.objects?.[0]) slots.objects[0].x = 64;

    expect(() =>
      compileTiledScene(map, { sceneId: "test_scene", displayName: "Test Scene" }),
    ).toThrow(/lands on a blocked tile/);
  });

  it("rejects disconnected semantic points", () => {
    const map = fixture();
    const collision = map.layers.find((layer) => layer.name === "collision");
    if (collision) {
      collision.objects = [{ id: 8, name: "wall", x: 64, y: 0, width: 32, height: 160 }];
    }

    expect(() =>
      compileTiledScene(map, { sceneId: "test_scene", displayName: "Test Scene" }),
    ).toThrow(/unreachable/);
  });

});
