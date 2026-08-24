import type { Direction, ScenePack, TilePosition } from "@uma-stage/contracts";

import { GridNavigation, tileKey, tilesAtManhattanRadius } from "./navigation";

/**
 * Adds deterministic, runtime-only cast spawns when authored map spawns are not
 * numerous enough. Authored spawns and portal destinations always keep priority.
 */
export function ensureSceneSpawnCapacity(
  scene: ScenePack,
  requiredPositions: number,
  preferredSpawnIds: string[] = [],
): ScenePack {
  const occupied = new Set(scene.spawns.map((spawn) => tileKey(spawn.position)));
  const navigation = new GridNavigation(scene);
  const reservedPortalTiles = new Set(scene.portals.map((portal) => tileKey(portal.position)));
  const spawnById = new Map(scene.spawns.map((spawn) => [spawn.id, spawn]));
  const generated: Array<{ id: string; position: TilePosition; facing: Direction }> = [];
  const preferredCounts = new Map<string, number>();
  for (const spawnId of preferredSpawnIds) {
    preferredCounts.set(spawnId, (preferredCounts.get(spawnId) ?? 0) + 1);
  }

  for (const [spawnId, count] of preferredCounts) {
    const spawn = spawnById.get(spawnId);
    if (!spawn || count <= 1) continue;
    addGeneratedSpawns(spawn.position, count - 1, spawn.facing);
  }

  if (occupied.size >= requiredPositions) {
    return generated.length === 0
      ? scene
      : { ...scene, spawns: [...scene.spawns, ...generated] };
  }

  const authoredSpawnOrigins = uniquePositions(
    scene.spawns.map((spawn) => spawn.position),
  ).filter((position) => navigation.isWalkable(position));
  const fallbackOrigins = uniquePositions([
    ...scene.anchors.flatMap((anchor) => [
      anchor.position,
      ...anchor.slots.map((slot) => slot.position),
    ]),
    { x: Math.floor(scene.map.width / 2), y: Math.floor(scene.map.height / 2) },
  ]).filter((position) => navigation.isWalkable(position));
  const origins = authoredSpawnOrigins.length > 0 ? authoredSpawnOrigins : fallbackOrigins;
  const searchOrigins = origins.length > 0 ? origins : [{ x: 0, y: 0 }];

  for (let radius = 0; radius <= scene.map.width + scene.map.height && occupied.size < requiredPositions; radius += 1) {
    for (const origin of searchOrigins) {
      for (const candidate of tilesAtManhattanRadius(origin, radius)) {
        if (!addGeneratedSpawn(candidate, "down")) continue;
        if (occupied.size >= requiredPositions) break;
      }
      if (occupied.size >= requiredPositions) break;
    }
  }

  if (occupied.size < requiredPositions) {
    throw new Error(
      `Scene ${scene.scene_id} has only ${occupied.size} walkable actor positions; ${requiredPositions} required`,
    );
  }
  return { ...scene, spawns: [...scene.spawns, ...generated] };

  function addGeneratedSpawns(
    origin: TilePosition,
    count: number,
    facing: Direction,
  ): void {
    let added = 0;
    for (let radius = 1; radius <= scene.map.width + scene.map.height && added < count; radius += 1) {
      for (const candidate of tilesAtManhattanRadius(origin, radius)) {
        if (!addGeneratedSpawn(candidate, facing)) continue;
        added += 1;
        if (added >= count) break;
      }
    }
  }

  function addGeneratedSpawn(candidate: TilePosition, facing: Direction): boolean {
    const key = tileKey(candidate);
    if (
      occupied.has(key) ||
      reservedPortalTiles.has(key) ||
      !navigation.isWalkable(candidate)
    ) return false;
    generated.push({
      id: `__cast_spawn_${generated.length + 1}`,
      position: candidate,
      facing,
    });
    occupied.add(key);
    return true;
  }
}

function uniquePositions(positions: TilePosition[]): TilePosition[] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = tileKey(position);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
