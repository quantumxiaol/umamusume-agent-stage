import { describe, expect, it } from "vitest";

import { scenePackSchema, worldPackSchema, type ScenePack } from "@uma-stage/contracts";

import { WorldNavigation } from "./world-navigation";

function scene(
  sceneId: string,
  portals: ScenePack["portals"],
  anchors: Array<{ id: string }> = [],
): ScenePack {
  return scenePackSchema.parse({
    schema_version: "scene_pack.v1",
    scene_id: sceneId,
    display_name: sceneId,
    map: { tile_size: 32, width: 8, height: 8 },
    navigation: { blocked_tiles: [] },
    anchors: anchors.map((anchor) => ({
      ...anchor,
      display_name: anchor.id,
      position: { x: 4, y: 4 },
    })),
    spawns: [{ id: "entry", position: { x: 1, y: 1 } }],
    portals,
  });
}

const world = worldPackSchema.parse({
  schema_version: "world_pack.v1",
  world_id: "test_world",
  display_name: "Test World",
  locations: ["a", "b", "c"].map((id) => ({
    id,
    display_name: id,
    scene_id: id,
    status: "playable",
  })),
});

describe("WorldNavigation", () => {
  it("finds the shortest portal sequence between scenes", () => {
    const navigation = new WorldNavigation(world, [
      scene("a", [{ id: "a-b", position: { x: 7, y: 4 }, target_scene_id: "b", target_spawn_id: "entry" }]),
      scene("b", [{ id: "b-c", position: { x: 7, y: 4 }, target_scene_id: "c", target_spawn_id: "entry" }]),
      scene("c", []),
    ]);

    expect(navigation.findRoute("a", "c")).toEqual({
      from_scene_id: "a",
      target_scene_id: "c",
      steps: [
        {
          from_scene_id: "a",
          portal_id: "a-b",
          exit_position: { x: 7, y: 4 },
          target_scene_id: "b",
          target_spawn_id: "entry",
        },
        {
          from_scene_id: "b",
          portal_id: "b-c",
          exit_position: { x: 7, y: 4 },
          target_scene_id: "c",
          target_spawn_id: "entry",
        },
      ],
    });
  });

  it("resolves an anchor in another scene", () => {
    const navigation = new WorldNavigation(world, [
      scene("a", [{ id: "a-b", position: { x: 7, y: 4 }, target_scene_id: "b", target_spawn_id: "entry" }]),
      scene("b", [{ id: "b-c", position: { x: 7, y: 4 }, target_scene_id: "c", target_spawn_id: "entry" }]),
      scene("c", [], [{ id: "finish" }]),
    ]);

    const destination = navigation.findAnchor("a", "finish");
    expect(destination?.scene_id).toBe("c");
    expect(destination?.route.steps.map((step) => step.portal_id)).toEqual(["a-b", "b-c"]);
  });
});
