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

function openRuntime() {
  const openScene: ScenePack = {
    ...scene,
    navigation: { blocked_tiles: [] }, portals: [],
    spawns: [
      { id: "a", position: { x: 1, y: 2 }, facing: "right" },
      { id: "b", position: { x: 3, y: 0 }, facing: "down" },
      { id: "blocker", position: { x: 3, y: 2 }, facing: "down" },
    ],
  };
  const runtime = new StageRuntime(openScene);
  runtime.spawnActor({ actorId: "a", characterPack: pack, spawnId: "a", controlOwner: "script" });
  return runtime;
}

describe("movement safety", () => {
  it("honours an explicit slot even when the anchor centre is closer", async () => {
    const runtime = openRuntime();
    const task = runtime.execute({ id: "exact", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "anchor", id: "meeting", slot_id: "right" } });
    runUntilSettled(runtime);
    expect(await task.completion).toMatchObject({ status: "completed" });
    expect(runtime.inspect().actors[0]?.tile).toEqual({ x: 4, y: 3 });
  });

  it("rejects unknown and occupied slots instead of falling back", async () => {
    const runtime = openRuntime();
    const unknown = runtime.execute({ id: "unknown", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "anchor", id: "meeting", slot_id: "typo" } });
    expect(await unknown.completion).toMatchObject({ status: "failed", error: { code: "INVALID_SLOT" } });
    runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "b", controlOwner: "script" });
    const occupy = runtime.execute({ id: "occupy", type: "actor.move_to", actor_id: "b", source: "script", policy: "replace", target: { type: "anchor", id: "meeting", slot_id: "right" } });
    runUntilSettled(runtime);
    expect(await occupy.completion).toMatchObject({ status: "completed" });
    const blocked = runtime.execute({ id: "blocked-slot", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "anchor", id: "meeting", slot_id: "right" } });
    expect(await blocked.completion).toMatchObject({ status: "failed" });
    expect(runtime.inspect().anchors[0]?.available_slots).not.toContain("right");
  });

  it("resolves crossing routes without sharing a tile or foot position", async () => {
    const runtime = openRuntime();
    runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "b", controlOwner: "script" });
    const tasks = [
      runtime.execute({ id: "east", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "tile", position: { x: 5, y: 2 } } }),
      runtime.execute({ id: "south", type: "actor.move_to", actor_id: "b", source: "script", policy: "replace", target: { type: "tile", position: { x: 3, y: 4 } } }),
    ];
    for (let i = 0; i < 400; i++) {
      runtime.tick(25);
      const [a, b] = runtime.snapshot().actors;
      expect(Math.hypot(a!.position.x - b!.position.x, a!.position.y - b!.position.y)).toBeGreaterThanOrEqual(32 * 0.6 - 0.001);
      expect(runtime.navigation.worldToTile(a!.position)).not.toEqual(runtime.navigation.worldToTile(b!.position));
    }
    expect((await Promise.all(tasks.map((task) => task.completion))).map((result) => result.status)).toEqual(["completed", "completed"]);
  });

  it("replans around an actor introduced after the path was planned", async () => {
    const runtime = openRuntime();
    const task = runtime.execute({ id: "detour", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "tile", position: { x: 6, y: 2 } } });
    runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "blocker", controlOwner: "script" });
    runUntilSettled(runtime);
    expect(await task.completion).toMatchObject({ status: "completed" });
    expect(runtime.inspect().actors[0]?.tile).toEqual({ x: 6, y: 2 });
  });

  it("lets four actors negotiate intersecting and opposing routes", async () => {
    const positions = [{ x: 1, y: 2 }, { x: 3, y: 0 }, { x: 5, y: 2 }, { x: 3, y: 4 }];
    const destinations = [{ x: 6, y: 2 }, { x: 3, y: 3 }, { x: 0, y: 2 }, { x: 3, y: 1 }];
    const runtime = new StageRuntime({ ...scene, navigation: { blocked_tiles: [] }, portals: [], spawns: positions.map((position, i) => ({ id: String(i), position, facing: "down" })) });
    for (let i = 0; i < 4; i++) runtime.spawnActor({ actorId: String(i), characterPack: pack, spawnId: String(i), controlOwner: "script" });
    const tasks = destinations.map((position, i) => runtime.execute({ id: `cross-${i}`, actor_id: String(i), type: "actor.move_to", source: "script", policy: "replace", target: { type: "tile", position } }));
    for (let tick = 0; tick < 600; tick++) {
      runtime.tick(25);
      const actors = runtime.snapshot().actors;
      for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i]!.position, b = actors[j]!.position;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(32 * 0.6 - 0.001);
      }
    }
    expect((await Promise.all(tasks.map((task) => task.completion))).map((result) => result.status)).toEqual(tasks.map(() => "completed"));
    expect(runtime.inspect().actors.map((actor) => actor.tile)).toEqual(destinations);
  });

  it("fails a permanently blocked move and releases its reservation for queued work", async () => {
    const corridor: ScenePack = { ...scene, map: { ...scene.map, width: 8, height: 1 }, portals: [], navigation: { blocked_tiles: [] }, spawns: [
      { id: "a", position: { x: 0, y: 0 }, facing: "right" },
      { id: "b", position: { x: 3, y: 0 }, facing: "left" },
    ] };
    const runtime = new StageRuntime(corridor);
    runtime.spawnActor({ actorId: "a", characterPack: pack, spawnId: "a", controlOwner: "script" });
    const blocked = runtime.execute({ id: "blocked", type: "actor.move_to", actor_id: "a", source: "script", policy: "replace", target: { type: "tile", position: { x: 7, y: 0 } } });
    const next = runtime.execute({ id: "return", type: "actor.move_to", actor_id: "a", source: "script", policy: "queue", target: { type: "tile", position: { x: 0, y: 0 } } });
    runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "b", controlOwner: "script" });
    runUntilSettled(runtime);
    expect(await blocked.completion).toMatchObject({ status: "failed", error: { code: "MOVE_BLOCKED" } });
    expect(await next.completion).toMatchObject({ status: "completed" });
  });

  it("preserves activity checkpoints when taking a dynamic detour", async () => {
    const runtime = openRuntime();
    const task = runtime.execute({ id: "activity-detour", type: "actor.follow_activity_path", actor_id: "a", source: "script", policy: "replace", activity_path_id: "warmup", cycles: 1 });
    runtime.spawnActor({ actorId: "b", characterPack: pack, spawnId: "blocker", controlOwner: "player" });
    runtime.setPlayerIntent("b", 0, -1);
    for (let i = 0; i < 5; i++) runtime.tick(50);
    runtime.setPlayerIntent("b", 0, 0);
    const visited = new Set<string>();
    for (let i = 0; i < 400; i++) { runtime.tick(25); visited.add(JSON.stringify(runtime.inspect().actors[0]?.tile)); }
    expect(await task.completion).toMatchObject({ status: "completed" });
    expect(visited.has(JSON.stringify({ x: 1, y: 1 }))).toBe(true);
    expect(visited.has(JSON.stringify({ x: 6, y: 1 }))).toBe(true);
  });
});

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

  it("uses the requested actor distance instead of collapsing meetings to one tile", async () => {
    const runtime = runtimeWithActors();
    const task = runtime.execute({
      id: "approach-b-with-stage-spacing",
      type: "actor.move_to",
      actor_id: "a",
      source: "script",
      policy: "replace",
      target: {
        type: "actor",
        id: "b",
        distance_tiles: 2,
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
    expect(tileA).toEqual({ x: tileB.x, y: tileB.y - 2 });
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
