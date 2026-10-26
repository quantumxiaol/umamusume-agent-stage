import type { AgentStageAction, StageEvent, TilePosition } from "@uma-stage/contracts";
import {
  StageRuntime,
  WorldNavigation,
  WorldPresence,
  type WorldRouteStep,
} from "@uma-stage/core";

export interface WorldTravelHost {
  readonly presence: WorldPresence;
  readonly navigation: WorldNavigation;
  definitionPathForScene(sceneId: string): string;
  currentRuntime(): StageRuntime | null;
  currentSceneId(): string;
  currentGeneration(): number;
  playerSceneId(): string;
  createBackgroundRuntime(sceneId: string): Promise<StageRuntime>;
  syncActor(runtime: StageRuntime, actorId: string): void;
  loadScene(definitionPath: string, signal: AbortSignal, skipPresenceSync?: boolean): Promise<StageRuntime>;
  setTraveling(active: boolean): void;
  report(message: string): void;
  actorName(actorId: string): string;
  sceneName(sceneId: string): string;
}

export async function travelActorToScene(
  host: WorldTravelHost,
  action: Extract<AgentStageAction, { type: "actor.travel_to_scene" }>,
  signal: AbortSignal,
): Promise<void> {
  const presence = host.presence.actor(action.actor_id);
  if (!presence) throw new Error(`缺少角色的世界位置：${action.actor_id}`);
  const actorName = host.actorName(action.actor_id);
  let ownedGeneration = host.currentGeneration();
  host.setTraveling(true);
  try {
    const route = host.navigation.findRoute(presence.scene_id, action.target_scene_id);
    if (!route) throw new Error(`${actorName}无法从${host.sceneName(presence.scene_id)}前往${host.sceneName(action.target_scene_id)}`);
    let runtime = await ensureTravelScene(host, presence.scene_id, action.actor_id, signal);
    ownedGeneration = host.currentGeneration();
    for (const step of route.steps) {
      throwIfCancelled(signal);
      if (runtime.scene.scene_id !== step.from_scene_id) {
        runtime = await ensureTravelScene(host, step.from_scene_id, action.actor_id, signal);
        ownedGeneration = host.currentGeneration();
      }
      host.report(`${actorName}正前往${host.sceneName(step.target_scene_id)}`);
      await moveTravelActor(host, runtime, action.actor_id, step.exit_position, signal, ownedGeneration, step);
      host.syncActor(runtime, action.actor_id);
      if (runtime === host.currentRuntime()) runtime.despawnActor(action.actor_id);
      host.presence.transferActor(action.actor_id, step.target_scene_id, step.target_spawn_id);
      runtime = await ensureTravelScene(host, step.target_scene_id, action.actor_id, signal, true);
      host.syncActor(runtime, action.actor_id);
      ownedGeneration = host.currentGeneration();
    }
    if (
      route.steps.length > 0 &&
      action.target_spawn_id &&
      route.steps.at(-1)?.target_spawn_id !== action.target_spawn_id
    ) {
      const spawn = runtime.scene.spawns.find((candidate) => candidate.id === action.target_spawn_id);
      if (!spawn) throw new Error(`目标场景没有出生点：${action.target_spawn_id}`);
      await moveTravelActor(host, runtime, action.actor_id, spawn.position, signal, ownedGeneration);
      host.syncActor(runtime, action.actor_id);
    }
    host.report(`${actorName}已到达${host.sceneName(action.target_scene_id)}`);
  } finally {
    host.setTraveling(false);
  }
}

async function ensureTravelScene(
  host: WorldTravelHost,
  sceneId: string,
  actorId: string,
  signal: AbortSignal,
  skipPresenceSync = false,
): Promise<StageRuntime> {
  throwIfCancelled(signal);
  const current = host.currentRuntime();
  if (current?.scene.scene_id === sceneId && hasActor(current, actorId)) return current;
  const runtime = sceneId === host.playerSceneId()
    ? await host.loadScene(host.definitionPathForScene(sceneId), signal, skipPresenceSync)
    : await host.createBackgroundRuntime(sceneId);
  throwIfCancelled(signal);
  if (runtime.scene.scene_id !== sceneId || !hasActor(runtime, actorId)) {
    throw new Error(`未能在${host.sceneName(sceneId)}装载旅行者：${host.actorName(actorId)}`);
  }
  return runtime;
}

async function moveTravelActor(
  host: WorldTravelHost,
  runtime: StageRuntime,
  actorId: string,
  position: TilePosition,
  signal: AbortSignal,
  ownedGeneration: number,
  portal?: WorldRouteStep,
): Promise<void> {
  throwIfCancelled(signal);
  const state = runtime.snapshot().actors.find((actor) => actor.actor_id === actorId);
  if (!state) throw new Error(`角色不在当前场景：${host.actorName(actorId)}`);
  if (state.control_owner !== "agent") runtime.setControlOwner(actorId, "agent");
  const portalEvents: StageEvent[] = [];
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "portal.entered" && event.actor_id === actorId) portalEvents.push(event);
  });
  try {
    const task = runtime.execute({
      id: `world-travel-${actorId}-${portal?.portal_id ?? "spawn"}-${Date.now()}`,
      type: "actor.move_to",
      actor_id: actorId,
      source: "agent",
      policy: "replace",
      target: { type: "tile", position },
    });
    const result = await waitForTravelTask(host, runtime, task, signal);
    if (host.currentGeneration() !== ownedGeneration) throw abortTravel("场景已被其他操作切换");
    if (result.status !== "completed") {
      throw new Error(`跨图步行失败：${result.error?.message ?? result.status}`);
    }
    const actor = runtime.snapshot().actors.find((candidate) => candidate.actor_id === actorId);
    if (!actor) throw new Error(`角色在步行后消失：${host.actorName(actorId)}`);
    const tile = runtime.navigation.worldToTile(actor.position);
    if (portal && (tile.x !== position.x || tile.y !== position.y)) {
      throw new Error(`角色只到达目标附近（${tile.x}, ${tile.y}），未进入指定位置（${position.x}, ${position.y}）`);
    }
    if (portal && !portalEvents.some((event) =>
      event.data.portal_id === portal.portal_id && event.data.target_scene_id === portal.target_scene_id,
    )) {
      throw new Error(`角色没有触发出口：${portal.portal_id}`);
    }
  } finally {
    unsubscribe();
  }
}

async function waitForTravelTask(
  host: WorldTravelHost,
  runtime: StageRuntime,
  task: ReturnType<StageRuntime["execute"]>,
  signal: AbortSignal,
) {
  throwIfCancelled(signal);
  const ticker = runtime !== host.currentRuntime()
    ? setInterval(() => {
        if (!signal.aborted) runtime.tick(16);
      }, 16)
    : null;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(abortTravel("跨图旅行已取消"));
    task.cancel("跨图旅行已取消");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const result = await Promise.race([task.completion, aborted]);
    throwIfCancelled(signal);
    return result;
  } finally {
    if (ticker !== null) clearInterval(ticker);
    signal.removeEventListener("abort", onAbort);
  }
}

function hasActor(runtime: StageRuntime, actorId: string): boolean {
  return runtime.snapshot().actors.some((actor) => actor.actor_id === actorId);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortTravel("跨图旅行已取消");
}

function abortTravel(message: string): Error {
  return new DOMException(message, "AbortError");
}
