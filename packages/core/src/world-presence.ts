import type {
  Direction,
  ScenePack,
  StageSnapshot,
  TilePosition,
} from "@uma-stage/contracts";

import { GridNavigation, tileKey, tilesAtManhattanRadius } from "./navigation";

export interface WorldActorPresence {
  actor_id: string;
  scene_id: string;
  tile: TilePosition | null;
  facing: Direction;
  spawn_id: string | null;
  following_actor_id: string | null;
  follow_distance_tiles: number | null;
}

export interface WorldFollowBinding {
  actorId: string;
  targetActorId: string;
  distanceTiles: number;
}

export interface ScenePresencePlacement {
  scene: ScenePack;
  spawnOverrides: Record<string, string>;
}

/**
 * Browser-session authority for actor location across SceneRuntime rebuilds.
 * StageRuntime still owns movement inside one scene; this store only snapshots
 * completed scene state and decides which actors are present after a transfer.
 */
export class WorldPresence {
  readonly #actors = new Map<string, WorldActorPresence>();

  reconcileActors(actorIds: Iterable<string>, defaultSceneId: string): void {
    const nextActorIds = new Set(actorIds);
    for (const actorId of this.#actors.keys()) {
      if (!nextActorIds.has(actorId)) this.#actors.delete(actorId);
    }
    for (const actorId of nextActorIds) {
      if (this.#actors.has(actorId)) continue;
      this.#actors.set(actorId, defaultPresence(actorId, defaultSceneId));
    }
    this.clearDanglingFollowBindings();
  }

  resetActors(actorIds: Iterable<string>, sceneId: string): void {
    this.#actors.clear();
    for (const actorId of actorIds) {
      this.#actors.set(actorId, defaultPresence(actorId, sceneId));
    }
  }

  syncScene(scene: ScenePack, snapshot: StageSnapshot): void {
    const navigation = new GridNavigation(scene);
    for (const actor of snapshot.actors) {
      this.#actors.set(actor.actor_id, {
        actor_id: actor.actor_id,
        scene_id: snapshot.scene_id,
        tile: navigation.worldToTile(actor.position),
        facing: actor.facing,
        spawn_id: null,
        following_actor_id: actor.following_actor_id,
        follow_distance_tiles: actor.follow_distance_tiles,
      });
    }
    this.clearDanglingFollowBindings();
  }

  actor(actorId: string): WorldActorPresence | undefined {
    const presence = this.#actors.get(actorId);
    return presence ? clonePresence(presence) : undefined;
  }

  actorsInScene(sceneId: string): WorldActorPresence[] {
    return [...this.#actors.values()]
      .filter((presence) => presence.scene_id === sceneId)
      .map(clonePresence);
  }

  followBindingsInScene(sceneId: string): WorldFollowBinding[] {
    const actorIds = new Set(this.actorsInScene(sceneId).map((presence) => presence.actor_id));
    return this.actorsInScene(sceneId).flatMap((presence) =>
      presence.following_actor_id &&
      presence.follow_distance_tiles &&
      actorIds.has(presence.following_actor_id)
        ? [{
            actorId: presence.actor_id,
            targetActorId: presence.following_actor_id,
            distanceTiles: presence.follow_distance_tiles,
          }]
        : [],
    );
  }

  transferFollowingParty(
    leaderActorId: string,
    sourceSceneId: string,
    targetSceneId: string,
    targetSpawnId: string,
  ): string[] {
    const leader = this.#actors.get(leaderActorId);
    if (!leader || leader.scene_id !== sourceSceneId) return [];
    const party = new Set([leaderActorId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const presence of this.#actors.values()) {
        if (
          presence.scene_id !== sourceSceneId ||
          !presence.following_actor_id ||
          party.has(presence.actor_id) ||
          !party.has(presence.following_actor_id)
        ) continue;
        party.add(presence.actor_id);
        changed = true;
      }
    }
    for (const actorId of party) {
      const presence = this.#actors.get(actorId);
      if (!presence) continue;
      presence.scene_id = targetSceneId;
      presence.tile = null;
      presence.spawn_id = targetSpawnId;
    }
    return [...party];
  }

  transferActor(actorId: string, targetSceneId: string, targetSpawnId: string | null): void {
    const presence = this.#actors.get(actorId);
    if (!presence) throw new Error(`Unknown world actor: ${actorId}`);
    presence.scene_id = targetSceneId;
    presence.tile = null;
    presence.spawn_id = targetSpawnId;
    presence.following_actor_id = null;
    presence.follow_distance_tiles = null;
    for (const candidate of this.#actors.values()) {
      if (candidate.following_actor_id !== actorId || candidate.scene_id === targetSceneId) continue;
      candidate.following_actor_id = null;
      candidate.follow_distance_tiles = null;
    }
  }

  private clearDanglingFollowBindings(): void {
    for (const presence of this.#actors.values()) {
      if (!presence.following_actor_id) continue;
      const target = this.#actors.get(presence.following_actor_id);
      if (target?.scene_id === presence.scene_id) continue;
      presence.following_actor_id = null;
      presence.follow_distance_tiles = null;
    }
  }
}

/** Adds runtime-only spawns for actors that previously remained in this scene. */
export function placeScenePresences(
  scene: ScenePack,
  presences: Iterable<WorldActorPresence>,
  explicitOverrides: Record<string, string> = {},
): ScenePresencePlacement {
  const navigation = new GridNavigation(scene);
  const spawns = [...scene.spawns];
  const overrides = { ...explicitOverrides };
  const occupied = new Set<string>();
  const portalTiles = new Set(scene.portals.map((portal) => tileKey(portal.position)));

  for (const presence of presences) {
    if (overrides[presence.actor_id] !== undefined) continue;
    if (presence.spawn_id && scene.spawns.some((spawn) => spawn.id === presence.spawn_id)) {
      overrides[presence.actor_id] = presence.spawn_id;
      continue;
    }
    if (!presence.tile) continue;
    const position = nearestSafePresenceTile(
      presence.tile,
      scene,
      navigation,
      occupied,
      portalTiles,
    );
    if (!position) continue;
    const existingSpawn = spawns.find((spawn) => tileKey(spawn.position) === tileKey(position));
    if (existingSpawn) {
      overrides[presence.actor_id] = existingSpawn.id;
    } else {
      const spawnId = `__world_actor_${safeId(presence.actor_id)}`;
      spawns.push({ id: spawnId, position, facing: presence.facing });
      overrides[presence.actor_id] = spawnId;
    }
    occupied.add(tileKey(position));
  }

  return {
    scene: spawns.length === scene.spawns.length ? scene : { ...scene, spawns },
    spawnOverrides: overrides,
  };
}

function nearestSafePresenceTile(
  origin: TilePosition,
  scene: ScenePack,
  navigation: GridNavigation,
  occupied: Set<string>,
  portalTiles: Set<string>,
): TilePosition | null {
  for (let radius = 0; radius <= scene.map.width + scene.map.height; radius += 1) {
    for (const candidate of tilesAtManhattanRadius(origin, radius)) {
      const key = tileKey(candidate);
      if (occupied.has(key) || portalTiles.has(key) || !navigation.isWalkable(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

function defaultPresence(actorId: string, sceneId: string): WorldActorPresence {
  return {
    actor_id: actorId,
    scene_id: sceneId,
    tile: null,
    facing: "down",
    spawn_id: null,
    following_actor_id: null,
    follow_distance_tiles: null,
  };
}

function clonePresence(presence: WorldActorPresence): WorldActorPresence {
  return {
    ...presence,
    tile: presence.tile ? { ...presence.tile } : null,
  };
}

function safeId(actorId: string): string {
  return actorId.replace(/[^a-z0-9_-]/giu, "_");
}
