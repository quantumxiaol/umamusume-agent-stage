import { describe, expect, it } from "vitest";

import { scenePackSchema, type StageSnapshot } from "@uma-stage/contracts";

import { placeScenePresences, WorldPresence } from "./world-presence";

const scene = scenePackSchema.parse({
  schema_version: "scene_pack.v1",
  scene_id: "plaza",
  display_name: "Plaza",
  map: { tile_size: 32, width: 10, height: 10 },
  navigation: { blocked_tiles: [] },
  spawns: [
    { id: "entry", position: { x: 1, y: 1 }, facing: "right" },
    { id: "other_portal_entry", position: { x: 8, y: 8 }, facing: "left" },
  ],
  portals: [{
    id: "exit",
    position: { x: 0, y: 1 },
    target_scene_id: "gate",
    target_spawn_id: "entry",
  }],
});

function snapshot(): StageSnapshot {
  return {
    scene_id: "plaza",
    time_ms: 100,
    actors: [
      {
        actor_id: "trainer",
        character_pack_id: "trainer",
        position: { x: 48, y: 48 },
        facing: "right",
        locomotion: "stand",
        control_owner: "player",
        speech: null,
        active_locomotion_task_id: null,
        following_actor_id: null,
        follow_distance_tiles: null,
      },
      {
        actor_id: "follower",
        character_pack_id: "follower",
        position: { x: 80, y: 48 },
        facing: "left",
        locomotion: "stand",
        control_owner: "agent",
        speech: null,
        active_locomotion_task_id: null,
        following_actor_id: "trainer",
        follow_distance_tiles: 2,
      },
      {
        actor_id: "friend",
        character_pack_id: "friend",
        position: { x: 144, y: 144 },
        facing: "down",
        locomotion: "stand",
        control_owner: "agent",
        speech: null,
        active_locomotion_task_id: null,
        following_actor_id: null,
        follow_distance_tiles: null,
      },
    ],
  };
}

describe("WorldPresence", () => {
  it("moves only the leader and its transitive followers between scenes", () => {
    const world = new WorldPresence();
    world.reconcileActors(["trainer", "follower", "friend", "tail"], "plaza");
    world.syncScene(scene, {
      ...snapshot(),
      actors: [
        ...snapshot().actors,
        {
          ...snapshot().actors[2]!,
          actor_id: "tail",
          following_actor_id: "follower",
          follow_distance_tiles: 1,
        },
      ],
    });

    expect(world.transferFollowingParty("trainer", "plaza", "gate", "from_plaza"))
      .toEqual(["trainer", "follower", "tail"]);
    expect(world.actorsInScene("gate").map((actor) => actor.actor_id))
      .toEqual(["trainer", "follower", "tail"]);
    expect(world.actor("friend")?.scene_id).toBe("plaza");
    expect(world.actor("friend")?.tile).toEqual({ x: 4, y: 4 });
  });

  it("moves one actor independently and clears cross-scene follow bindings", () => {
    const world = new WorldPresence();
    world.reconcileActors(["trainer", "follower", "friend"], "plaza");
    world.syncScene(scene, snapshot());

    world.transferActor("trainer", "gate", "from_plaza");

    expect(world.actor("trainer")).toMatchObject({
      scene_id: "gate",
      spawn_id: "from_plaza",
    });
    expect(world.actor("follower")?.following_actor_id).toBeNull();
  });

  it("restores a resident at its saved tile with a runtime-only spawn", () => {
    const world = new WorldPresence();
    world.reconcileActors(["trainer", "follower", "friend"], "plaza");
    world.syncScene(scene, snapshot());
    world.transferFollowingParty("trainer", "plaza", "gate", "from_plaza");

    const placement = placeScenePresences(scene, world.actorsInScene("plaza"));
    const spawnId = placement.spawnOverrides.friend;
    const spawn = placement.scene.spawns.find((candidate) => candidate.id === spawnId);

    expect(spawn?.position).toEqual({ x: 4, y: 4 });
    expect(spawn?.id).toBe("__world_actor_friend");
  });
});
