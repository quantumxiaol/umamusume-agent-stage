import { afterEach, describe, expect, it } from "vitest";
import {
  scenePackSchema,
  worldPackSchema,
  type CharacterPack,
  type ScenePack,
} from "@uma-stage/contracts";
import { StageRuntime, WorldNavigation, WorldPresence } from "@uma-stage/core";

import { travelActorToScene, type WorldTravelHost } from "./world-travel";

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
    stand: { fps: 1, loop: false, fallback: null, directions: { down: ["d"], left: ["l"], right: ["r"], up: ["u"] } },
    walk: { fps: 8, loop: true, directions: {}, fallback: "stand" },
    idle: { fps: 4, loop: true, directions: {}, fallback: "stand" },
  },
};

const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

function scene(sceneId: string, targetSceneId?: string): ScenePack {
  return scenePackSchema.parse({
    schema_version: "scene_pack.v1",
    scene_id: sceneId,
    display_name: sceneId,
    map: { tile_size: 32, width: 7, height: 5 },
    navigation: { blocked_tiles: [] },
    spawns: [
      { id: "entry", position: { x: 1, y: 2 }, facing: "right" },
      { id: "entry_alt", position: { x: 1, y: 3 }, facing: "right" },
      { id: "player", position: { x: 1, y: 1 }, facing: "down" },
      { id: "blocked", position: { x: 4, y: 2 }, facing: "down" },
    ],
    portals: targetSceneId ? [{
      id: `${sceneId}-exit`,
      position: { x: 4, y: 2 },
      target_scene_id: targetSceneId,
      target_spawn_id: "entry",
    }] : [],
  });
}

function createHost(blockPortal = false, blockTargetSpawn = false, recallToPlayer = false) {
  const scenes = [scene("a", "b"), scene("b", recallToPlayer ? "a" : "c"), scene("c")];
  const world = worldPackSchema.parse({
    schema_version: "world_pack.v1",
    world_id: "test_world",
    display_name: "Test",
    locations: scenes.map((entry) => ({ id: entry.scene_id, display_name: entry.scene_id, scene_id: entry.scene_id, status: "playable" })),
  });
  const presence = new WorldPresence();
  presence.reconcileActors(["uma", "trainer", ...(blockPortal || blockTargetSpawn ? ["blocker"] : [])], "a");
  if (blockTargetSpawn) presence.transferActor("blocker", "b", "entry");
  let current: StageRuntime | null = null;
  let currentScene = "a";
  let generation = 0;
  let traveling = false;
  let tickingVisible = false;
  const loadCalls: Array<{ sceneId: string; skip: boolean }> = [];
  const backgroundCalls: string[] = [];
  const backgroundRuntimes: StageRuntime[] = [];
  const manualTicks = new Map<StageRuntime, number>();
  const reports: string[] = [];
  const createRuntime = (sceneId: string) => {
    const definition = scenes.find((entry) => entry.scene_id === sceneId);
    if (!definition) throw new Error(`Unknown scene ${sceneId}`);
    const next = new StageRuntime(definition);
    if (presence.actor("uma")?.scene_id === sceneId) {
      next.spawnActor({ actorId: "uma", characterPack: pack, spawnId: blockTargetSpawn && sceneId === "b" ? "entry_alt" : "entry", controlOwner: "agent" });
    }
    if (sceneId === "a" && presence.actor("trainer")?.scene_id === "a") {
      next.spawnActor({ actorId: "trainer", characterPack: pack, spawnId: "player", controlOwner: "player" });
    }
    if (sceneId === "a" && blockPortal && presence.actor("blocker")?.scene_id === "a") {
      next.spawnActor({ actorId: "blocker", characterPack: pack, spawnId: "blocked", controlOwner: "system" });
    }
    if (sceneId === "b" && blockTargetSpawn && presence.actor("blocker")?.scene_id === "b") {
      next.spawnActor({ actorId: "blocker", characterPack: pack, spawnId: "entry", controlOwner: "system" });
    }
    const tick = next.tick.bind(next);
    next.tick = (deltaMs) => {
      if (!tickingVisible) manualTicks.set(next, (manualTicks.get(next) ?? 0) + 1);
      tick(deltaMs);
    };
    return next;
  };
  const host: WorldTravelHost = {
    presence,
    navigation: new WorldNavigation(world, scenes),
    definitionPathForScene: (sceneId) => sceneId,
    currentRuntime: () => current,
    currentSceneId: () => currentScene,
    currentGeneration: () => generation,
    playerSceneId: () => presence.actor("trainer")?.scene_id ?? "a",
    createBackgroundRuntime: async (sceneId) => {
      const next = createRuntime(sceneId);
      backgroundCalls.push(sceneId);
      backgroundRuntimes.push(next);
      return next;
    },
    syncActor: (runtime, actorId) => {
      const snapshot = runtime.snapshot();
      presence.syncScene(runtime.scene, {
        ...snapshot,
        actors: snapshot.actors.filter((actor) => actor.actor_id === actorId),
      });
    },
    loadScene: async (sceneId, signal, skip = false) => {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (current && !skip) presence.syncScene(current.scene, current.snapshot());
      current?.dispose("test reload");
      const next = createRuntime(sceneId);
      current = next;
      currentScene = sceneId;
      generation += 1;
      loadCalls.push({ sceneId, skip });
      return next;
    },
    setTraveling: (active) => { traveling = active; },
    report: (message) => { reports.push(message); },
    actorName: (actorId) => actorId,
    sceneName: (sceneId) => sceneId,
  };
  timers.push(setInterval(() => {
    if (!current) return;
    tickingVisible = true;
    try {
      current.tick(10);
    } finally {
      tickingVisible = false;
    }
  }, 1));
  return {
    host,
    loadCalls,
    backgroundCalls,
    backgroundRuntimes,
    reports,
    manualTickCount: (runtime: StageRuntime) => manualTicks.get(runtime) ?? 0,
    isTraveling: () => traveling,
    start: () => host.loadScene("a", new AbortController().signal),
  };
}

describe("world travel", () => {
  it("walks through every portal without changing the player scene", async () => {
    const fixture = createHost();
    const visible = await fixture.start();
    fixture.loadCalls.splice(0);

    await travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "c",
    }, new AbortController().signal);

    expect(fixture.loadCalls).toEqual([]);
    expect(fixture.backgroundCalls).toEqual(["b", "c"]);
    expect(fixture.host.currentRuntime()).toBe(visible);
    expect(visible.snapshot().actors.map((actor) => actor.actor_id)).toEqual(["trainer"]);
    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("c");
    expect(fixture.host.presence.actor("trainer")?.scene_id).toBe("a");
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.isTraveling()).toBe(false);
  });

  it("ticks background tasks but never manually ticks the visible runtime", async () => {
    const fixture = createHost();
    const visible = await fixture.start();

    await travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "c",
    }, new AbortController().signal);

    const background = fixture.backgroundRuntimes.find((runtime) => runtime.scene.scene_id === "b");
    expect(background).toBeDefined();
    expect(fixture.manualTickCount(background!)).toBeGreaterThan(0);
    expect(fixture.manualTickCount(visible)).toBe(0);
    const completedTicks = fixture.manualTickCount(background!);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.manualTickCount(background!)).toBe(completedTicks);
  });

  it("accepts a safe nearby placement when the requested entry spawn is occupied", async () => {
    const fixture = createHost(false, true);
    await fixture.start();

    await travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "b",
      target_spawn_id: "entry",
    }, new AbortController().signal);

    expect(fixture.host.presence.actor("uma")).toMatchObject({
      scene_id: "b",
      tile: { x: 1, y: 3 },
    });
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.isTraveling()).toBe(false);
  });

  it("does not reload or teleport for same-scene travel", async () => {
    const fixture = createHost();
    const runtime = await fixture.start();
    const before = runtime.snapshot().actors.find((actor) => actor.actor_id === "uma")?.position;
    fixture.loadCalls.splice(0);

    await travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "a",
    }, new AbortController().signal);

    expect(fixture.loadCalls).toEqual([]);
    expect(fixture.backgroundCalls).toEqual([]);
    expect(fixture.host.currentRuntime()?.snapshot().actors.find((actor) => actor.actor_id === "uma")?.position).toEqual(before);
    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("a");
  });

  it("cancels a visible walk without transferring or remaining busy", async () => {
    const fixture = createHost();
    const visible = await fixture.start();
    const controller = new AbortController();
    const travel = travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "b",
    }, controller.signal);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (visible.snapshot().actors.some((actor) => actor.active_locomotion_task_id)) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(visible.snapshot().actors.some((actor) => actor.active_locomotion_task_id)).toBe(true);
    controller.abort();

    await expect(travel).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("a");
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.isTraveling()).toBe(false);
    expect(visible.snapshot().actors.find((actor) => actor.actor_id === "uma")?.active_locomotion_task_id).toBeNull();
  });

  it("cancels a background walk and cleans up its ticker", async () => {
    const fixture = createHost();
    const visible = await fixture.start();
    fixture.loadCalls.splice(0);
    const controller = new AbortController();
    const travel = travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "c",
    }, controller.signal);
    let background: StageRuntime | undefined;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      background = fixture.backgroundRuntimes.find((runtime) =>
        runtime.scene.scene_id === "b" &&
        runtime.snapshot().actors.some((actor) => actor.actor_id === "uma" && actor.active_locomotion_task_id),
      );
      if (background) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(background).toBeDefined();
    controller.abort();

    await expect(travel).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("b");
    expect(fixture.host.currentRuntime()).toBe(visible);
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.loadCalls).toEqual([]);
    expect(fixture.isTraveling()).toBe(false);
    expect(background!.snapshot().actors.find((actor) => actor.actor_id === "uma")?.active_locomotion_task_id).toBeNull();
    const cancelledTicks = fixture.manualTickCount(background!);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.manualTickCount(background!)).toBe(cancelledTicks);
  });

  it("uses visible assembly only when recalling an actor to the player scene", async () => {
    const fixture = createHost(false, false, true);
    fixture.host.presence.transferActor("uma", "b", "entry");
    await fixture.start();
    fixture.loadCalls.splice(0);

    await travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "a",
    }, new AbortController().signal);

    expect(fixture.backgroundCalls).toEqual(["b"]);
    expect(fixture.loadCalls).toEqual([{ sceneId: "a", skip: true }]);
    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("a");
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.isTraveling()).toBe(false);
  });

  it("rejects an unknown destination without changing presence", async () => {
    const fixture = createHost();
    await fixture.start();

    await expect(travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "missing",
    }, new AbortController().signal)).rejects.toThrow("Unknown playable target scene");

    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("a");
    expect(fixture.isTraveling()).toBe(false);
  });

  it("rejects a destination with no route without changing the visible scene", async () => {
    const fixture = createHost();
    fixture.host.presence.transferActor("uma", "c", "entry");
    await fixture.start();

    await expect(travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "a",
    }, new AbortController().signal)).rejects.toThrow("uma无法从c前往a");

    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("c");
    expect(fixture.host.currentSceneId()).toBe("a");
    expect(fixture.backgroundCalls).toEqual([]);
    expect(fixture.isTraveling()).toBe(false);
  });

  it("does not transfer when the portal is occupied", async () => {
    const fixture = createHost(true);
    await fixture.start();

    await expect(travelActorToScene(fixture.host, {
      type: "actor.travel_to_scene",
      actor_id: "uma",
      target_scene_id: "b",
    }, new AbortController().signal)).rejects.toThrow();

    expect(fixture.host.presence.actor("uma")?.scene_id).toBe("a");
    expect(fixture.loadCalls.map((call) => call.sceneId)).not.toContain("b");
    expect(fixture.backgroundCalls).not.toContain("b");
    expect(fixture.isTraveling()).toBe(false);
  });
});
