import { describe, expect, it } from "vitest";

import { scenePackSchema, stageActorDefinitionSchema } from "@uma-stage/contracts";

import { assignStageSpawns } from "./spawn-assignment";

const scene = scenePackSchema.parse({
  schema_version: "scene_pack.v1",
  scene_id: "spawn_test",
  display_name: "Spawn Test",
  map: { tile_size: 32, width: 8, height: 8 },
  navigation: { blocked_tiles: [] },
  spawns: [
    { id: "portal_entry", position: { x: 1, y: 1 } },
    { id: "trainer_default", position: { x: 4, y: 4 } },
  ],
});
const actors = [
  stageActorDefinitionSchema.parse({
    instance_id: "trainer",
    bundle_id: "trainer",
    spawn_id: "trainer_default",
    control_owner: "player",
    player: true,
  }),
  stageActorDefinitionSchema.parse({
    instance_id: "character",
    bundle_id: "character",
    spawn_id: "portal_entry",
    control_owner: "agent",
  }),
];

describe("assignStageSpawns", () => {
  it("prioritizes the arriving actor and relocates a conflicting cast member", () => {
    expect(assignStageSpawns(actors, scene, { trainer: "portal_entry" })).toEqual({
      trainer: "portal_entry",
      character: "trainer_default",
    });
  });

  it("keeps default spawns when they do not conflict", () => {
    expect(assignStageSpawns(actors, scene)).toEqual({
      trainer: "trainer_default",
      character: "portal_entry",
    });
  });

  it("rejects an unknown portal spawn", () => {
    expect(() => assignStageSpawns(actors, scene, { trainer: "missing" })).toThrow(
      "Unknown spawn override",
    );
  });

  it("relocates duplicate spawn requests to the nearest free spawn", () => {
    const expandedScene = scenePackSchema.parse({
      ...scene,
      spawns: [
        ...scene.spawns,
        { id: "nearby", position: { x: 2, y: 2 } },
        { id: "far", position: { x: 7, y: 7 } },
      ],
    });
    const cast = [
      actors[0]!,
      actors[1]!,
      stageActorDefinitionSchema.parse({
        instance_id: "character_two",
        bundle_id: "character",
        spawn_id: "portal_entry",
        control_owner: "agent",
      }),
    ];

    expect(assignStageSpawns(cast, expandedScene)).toEqual({
      trainer: "trainer_default",
      character: "portal_entry",
      character_two: "nearby",
    });
  });
});
