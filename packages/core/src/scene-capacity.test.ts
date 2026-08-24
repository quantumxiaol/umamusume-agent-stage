import { describe, expect, it } from "vitest";

import { scenePackSchema } from "@uma-stage/contracts";

import { ensureSceneSpawnCapacity } from "./scene-capacity";

const scene = scenePackSchema.parse({
  schema_version: "scene_pack.v1",
  scene_id: "capacity_test",
  display_name: "Capacity Test",
  map: { tile_size: 32, width: 6, height: 6 },
  navigation: { blocked_tiles: [{ x: 1, y: 0 }] },
  spawns: [{ id: "entrance", position: { x: 0, y: 0 }, facing: "right" }],
  portals: [
    {
      id: "exit",
      position: { x: 0, y: 1 },
      target_scene_id: "next",
      target_spawn_id: "entry",
    },
  ],
});

describe("ensureSceneSpawnCapacity", () => {
  it("adds unique walkable spawns without using portal tiles", () => {
    const result = ensureSceneSpawnCapacity(scene, 4);
    const positions = result.spawns.map((spawn) => `${spawn.position.x},${spawn.position.y}`);

    expect(new Set(positions).size).toBeGreaterThanOrEqual(4);
    expect(positions.slice(1)).not.toContain("0,1");
    expect(positions.slice(1)).not.toContain("1,0");
    expect(result.spawns.slice(1).every((spawn) => spawn.id.startsWith("__cast_spawn_"))).toBe(true);
  });

  it("keeps the authored scene when it already has enough capacity", () => {
    expect(ensureSceneSpawnCapacity(scene, 1)).toBe(scene);
  });

  it("adds formation spawns near a duplicated preferred spawn", () => {
    const roomyScene = scenePackSchema.parse({
      ...scene,
      navigation: { blocked_tiles: [] },
      portals: [],
      spawns: [
        ...scene.spawns,
        { id: "far", position: { x: 5, y: 5 }, facing: "up" },
      ],
    });
    const result = ensureSceneSpawnCapacity(roomyScene, 2, ["entrance", "entrance"]);
    const generated = result.spawns.find((spawn) => spawn.id === "__cast_spawn_1");

    expect(generated).toBeDefined();
    expect(
      Math.abs(generated!.position.x) + Math.abs(generated!.position.y),
    ).toBe(1);
  });
});
