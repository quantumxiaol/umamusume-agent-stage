import type { CharacterPack, ScenePack } from "@uma-stage/contracts";
import { describe, expect, it } from "vitest";

import { StageRuntime } from "./runtime";

const pack: CharacterPack = {
  schema_version: 1,
  actor_id: "test_pack",
  display_name: "Test",
  outfit_id: "default",
  atlas: { image: "atlas.png", data: "atlas.json" },
  render: { frame_width: 64, frame_height: 64, anchor_x: 32, anchor_y: 61, scale: 1 },
  movement: { speed_px_per_second: 128, idle_after_ms: 500 },
  default_direction: "down",
  animations: {
    stand: {
      fps: 1, loop: false, fallback: null,
      directions: { down: ["d"], left: ["l"], right: ["r"], up: ["u"] },
    },
    walk: { fps: 8, loop: true, directions: {}, fallback: "stand" },
    idle: { fps: 4, loop: true, directions: {}, fallback: "stand" },
  },
};

const scene: ScenePack = {
  schema_version: "scene_pack.v1",
  scene_id: "runtime_test",
  display_name: "Runtime Test",
  description: "",
  map: { tile_size: 32, width: 8, height: 5, background_color: "#000000" },
  layers: [], landmarks: [],
  navigation: { blocked_tiles: [{ x: 3, y: 2 }] },
  zones: [], surfaces: [], props: [],
  portals: [{
    id: "exit", position: { x: 2, y: 2 }, target_scene_id: "next", target_spawn_id: "entry",
  }],
  activity_paths: [{
    id: "warmup", activity_id: "jog", loop: false,
    points: [{ x: 1, y: 1 }, { x: 6, y: 1 }],
  }],
  spawns: [
    { id: "a", position: { x: 1, y: 2 }, facing: "right" },
    { id: "b", position: { x: 6, y: 2 }, facing: "left" },
  ],
  anchors: [{
    id: "meeting", display_name: "Meeting", description: "", position: { x: 4, y: 2 },
    tags: [], interactions: [], slots: [
      { id: "left", position: { x: 4, y: 1 }, facing: "down" },
      { id: "right", position: { x: 4, y: 3 }, facing: "up" },
    ],
  }],
};

function runtimeWithActors() {
  const runtime = new StageRuntime(scene);
  runtime.spawnActor({ actorId: "a", characterPack: pack, spawnId: "a", controlOwner: "script" });
  runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "b", controlOwner: "script" });
  return runtime;
}

function runUntilSettled(runtime: StageRuntime, ticks = 200) {
  for (let index = 0; index < ticks; index += 1) runtime.tick(50);
}

describe("StageRuntime", () => {
  it("moves two actors to distinct reserved anchor slots", async () => {
    const runtime = runtimeWithActors();
    const first = runtime.execute({
      id: "move-a", type: "actor.move_to", actor_id: "a", source: "script", policy: "reject",
      target: { type: "anchor", id: "meeting" },
    });
    const second = runtime.execute({
      id: "move-b", type: "actor.move_to", actor_id: "b", source: "script", policy: "reject",
      target: { type: "anchor", id: "meeting" },
    });
    runUntilSettled(runtime);

    await expect(first.completion).resolves.toMatchObject({ status: "completed" });
    await expect(second.completion).resolves.toMatchObject({ status: "completed" });
    const tiles = runtime.snapshot().actors.map((actor) => runtime.navigation.worldToTile(actor.position));
    expect(new Set(tiles.map((tile) => `${tile.x},${tile.y}`)).size).toBe(2);
  });

  it("supports replace and cancellation on the locomotion channel", async () => {
    const runtime = runtimeWithActors();
    const oldTask = runtime.execute({
      id: "old", type: "actor.move_to", actor_id: "a", source: "script", policy: "reject",
      target: { type: "tile", position: { x: 7, y: 4 } },
    });
    const replacement = runtime.execute({
      id: "new", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace",
      target: { type: "anchor", id: "meeting", slot_id: "left" },
    });
    runUntilSettled(runtime);

    await expect(oldTask.completion).resolves.toMatchObject({ status: "cancelled" });
    await expect(replacement.completion).resolves.toMatchObject({ status: "completed" });
  });

  it("approaches another actor and faces them", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "approach-b",
      type: "actor.move_to",
      actor_id: "a",
      source: "script",
      policy: "replace",
      target: { type: "actor", id: "b", distance_tiles: 1 },
    });
    runUntilSettled(runtime);

    await expect(task.completion).resolves.toMatchObject({ status: "completed" });
    const actors = runtime.snapshot().actors;
    const actorA = actors.find((actor) => actor.actor_id === "a")!;
    const actorB = actors.find((actor) => actor.actor_id === "b")!;
    const tileA = runtime.navigation.worldToTile(actorA.position);
    const tileB = runtime.navigation.worldToTile(actorB.position);
    expect(Math.abs(tileA.x - tileB.x) + Math.abs(tileA.y - tileB.y)).toBe(1);
    expect(actorA.facing).toBe("right");
  });

  it("prefers an above-stage meeting position so the approaching actor faces down", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "approach-b-from-above",
      type: "actor.move_to",
      actor_id: "a",
      source: "script",
      policy: "replace",
      target: {
        type: "actor",
        id: "b",
        distance_tiles: 1,
        preferred_side: "above",
      },
    });
    runUntilSettled(runtime);

    await expect(task.completion).resolves.toMatchObject({ status: "completed" });
    const actors = runtime.snapshot().actors;
    const actorA = actors.find((actor) => actor.actor_id === "a")!;
    const actorB = actors.find((actor) => actor.actor_id === "b")!;
    const tileA = runtime.navigation.worldToTile(actorA.position);
    const tileB = runtime.navigation.worldToTile(actorB.position);
    expect(tileA).toEqual({ x: tileB.x, y: tileB.y - 1 });
    expect(actorA.facing).toBe("down");
  });

  it("faces a live actor by semantic target", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "face-b",
      type: "actor.face_actor",
      actor_id: "a",
      target_actor_id: "b",
      source: "script",
      policy: "replace",
    });

    await expect(task.completion).resolves.toMatchObject({ status: "completed" });
    expect(runtime.snapshot().actors.find((actor) => actor.actor_id === "a")?.facing).toBe("right");
  });

  it("keeps following a moving actor until following is stopped", async () => {
    const runtime = runtimeWithActors();
    const follow = runtime.execute({
      id: "follow-b",
      type: "actor.follow",
      actor_id: "a",
      target_actor_id: "b",
      distance_tiles: 2,
      source: "script",
      policy: "replace",
    });

    await expect(follow.completion).resolves.toMatchObject({ status: "completed" });
    expect(runtime.snapshot().actors.find((actor) => actor.actor_id === "a")).toMatchObject({
      following_actor_id: "b",
      follow_distance_tiles: 2,
    });
    runUntilSettled(runtime);

    runtime.setControlOwner("b", "player");
    runtime.setPlayerIntent("b", 0, 1);
    for (let index = 0; index < 10; index += 1) runtime.tick(50);
    runtime.setPlayerIntent("b", 0, 0);
    runUntilSettled(runtime);

    const followedActors = runtime.snapshot().actors;
    const followerTile = runtime.navigation.worldToTile(
      followedActors.find((actor) => actor.actor_id === "a")!.position,
    );
    const targetTile = runtime.navigation.worldToTile(
      followedActors.find((actor) => actor.actor_id === "b")!.position,
    );
    expect(Math.abs(followerTile.x - targetTile.x) + Math.abs(followerTile.y - targetTile.y)).toBeLessThanOrEqual(2);

    const stop = runtime.execute({
      id: "stop-following",
      type: "actor.stop_follow",
      actor_id: "a",
      source: "script",
      policy: "replace",
    });
    await expect(stop.completion).resolves.toMatchObject({ status: "completed" });
    expect(runtime.snapshot().actors.find((actor) => actor.actor_id === "a")).toMatchObject({
      following_actor_id: null,
      follow_distance_tiles: null,
    });
    expect(runtime.events().map((event) => event.type)).toEqual(
      expect.arrayContaining(["actor.follow_started", "actor.follow_stopped"]),
    );
  });

  it("runs a replacement before work that was already queued", async () => {
    const runtime = runtimeWithActors();
    runtime.execute({
      id: "active", type: "actor.move_to", actor_id: "a", source: "script", policy: "reject",
      target: { type: "tile", position: { x: 7, y: 4 } },
    });
    const queued = runtime.execute({
      id: "queued", type: "actor.move_to", actor_id: "a", source: "script", policy: "queue",
      target: { type: "tile", position: { x: 1, y: 4 } },
    });
    const replacement = runtime.execute({
      id: "replacement", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace",
      target: { type: "anchor", id: "meeting", slot_id: "left" },
    });
    runUntilSettled(runtime);

    await expect(replacement.completion).resolves.toMatchObject({ status: "completed" });
    await expect(queued.completion).resolves.toMatchObject({ status: "completed" });
    const arrivals = runtime.events().filter((event) => event.type === "actor.arrived");
    expect(arrivals.map((event) => event.command_id)).toEqual(["replacement", "queued"]);
  });

  it("enforces control ownership", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "denied", type: "actor.move_to", actor_id: "a", source: "agent", policy: "reject",
      target: { type: "anchor", id: "meeting" },
    });

    await expect(task.completion).resolves.toMatchObject({
      status: "failed",
      error: { code: "CONTROL_DENIED" },
    });
  });

  it("follows a named activity path as one locomotion task", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "warmup-1",
      type: "actor.follow_activity_path",
      actor_id: "a",
      source: "script",
      policy: "replace",
      activity_path_id: "warmup",
      cycles: 1,
    });
    runUntilSettled(runtime);

    await expect(task.completion).resolves.toMatchObject({ status: "completed" });
    const actor = runtime.snapshot().actors.find((candidate) => candidate.actor_id === "a");
    expect(actor && runtime.navigation.worldToTile(actor.position)).toEqual({ x: 6, y: 1 });
  });

  it("emits one portal event when an actor enters a portal tile", () => {
    const runtime = runtimeWithActors();
    runtime.setPlayerIntent("a", 1, 0);
    runtime.setControlOwner("a", "player");
    runtime.setPlayerIntent("a", 1, 0);
    for (let index = 0; index < 8; index += 1) runtime.tick(50);

    const portalEvents = runtime.events().filter((event) => event.type === "portal.entered");
    expect(portalEvents).toHaveLength(1);
    expect(portalEvents[0]?.data).toMatchObject({
      portal_id: "exit",
      target_scene_id: "next",
      target_spawn_id: "entry",
    });
  });
});
