import type { ScenePack } from "@uma-stage/contracts";
import { describe, expect, it } from "vitest";

import { GridNavigation } from "./navigation";

const scene: ScenePack = {
  schema_version: "scene_pack.v1",
  scene_id: "navigation_test",
  display_name: "Navigation Test",
  description: "",
  map: { tile_size: 32, width: 6, height: 5, background_color: "#000000" },
  layers: [], landmarks: [],
  navigation: { blocked_tiles: [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }] },
  zones: [], surfaces: [], props: [], anchors: [], spawns: [], portals: [], activity_paths: [],
};

describe("GridNavigation", () => {
  it("finds an A* path around static collision", () => {
    const navigation = new GridNavigation(scene);
    const path = navigation.findPath({ x: 1, y: 2 }, { x: 4, y: 2 });

    expect(path[0]).not.toEqual({ x: 2, y: 2 });
    expect(path.at(-1)).toEqual({ x: 4, y: 2 });
    expect(path).toHaveLength(7);
  });

  it("selects a nearby free and reachable target", () => {
    const navigation = new GridNavigation(scene);
    const target = navigation.findNearestAvailable(
      { x: 4, y: 2 },
      {
        from: { x: 1, y: 2 },
        isOccupied: (position) => position.x === 4 && position.y === 2,
      },
    );

    expect(target).toEqual({ x: 3, y: 2 });
  });
});
