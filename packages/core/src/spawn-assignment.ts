import type { ScenePack, StageActorDefinition } from "@uma-stage/contracts";

export function assignStageSpawns(
  actors: StageActorDefinition[],
  scene: ScenePack,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const spawnById = new Map(scene.spawns.map((spawn) => [spawn.id, spawn]));
  const assignments: Record<string, string> = {};
  const occupiedPositions = new Set<string>();
  const prioritizedActors = [
    ...actors.filter((actor) => overrides[actor.instance_id] !== undefined),
    ...actors.filter((actor) => overrides[actor.instance_id] === undefined),
  ];

  for (const actor of prioritizedActors) {
    const override = overrides[actor.instance_id];
    if (override !== undefined && !spawnById.has(override)) {
      throw new Error(`Unknown spawn override for ${actor.instance_id}: ${override}`);
    }
    const preferredSpawn = spawnById.get(override ?? actor.spawn_id);
    const nearestSpawnIds = [...scene.spawns]
      .sort((left, right) =>
        preferredSpawn
          ? manhattan(left.position, preferredSpawn.position) -
            manhattan(right.position, preferredSpawn.position)
          : 0,
      )
      .map((spawn) => spawn.id);
    const candidateIds = uniqueStrings([
      ...(override === undefined ? [] : [override]),
      ...nearestSpawnIds,
      actor.spawn_id,
    ]);
    const selected = candidateIds.find((spawnId) => {
      const spawn = spawnById.get(spawnId);
      return spawn !== undefined && !occupiedPositions.has(positionKey(spawn.position));
    });
    if (!selected) {
      throw new Error(`No free spawn is available for ${actor.instance_id} in ${scene.scene_id}`);
    }
    const spawn = spawnById.get(selected);
    if (!spawn) throw new Error(`Unknown stage spawn for ${actor.instance_id}: ${selected}`);
    assignments[actor.instance_id] = selected;
    occupiedPositions.add(positionKey(spawn.position));
  }

  return assignments;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function positionKey(position: { x: number; y: number }): string {
  return `${position.x},${position.y}`;
}

function manhattan(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}
