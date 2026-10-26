import type {
  CharacterPack,
  ScenePack,
  StageDefinition,
} from "@uma-stage/contracts";
import {
  assignStageSpawns,
  ensureSceneSpawnCapacity,
  placeScenePresences,
  StageRuntime,
  WorldPresence,
  type WorldFollowBinding,
} from "@uma-stage/core";

export function assembleSceneActors(options: {
  sourceScene: ScenePack;
  stage: StageDefinition;
  presences: WorldPresence;
  packs: CharacterPack[];
  spawnOverrides?: Record<string, string>;
  followBindings?: WorldFollowBinding[];
  nextCommandId(prefix: string): string;
}): { scene: ScenePack; runtime: StageRuntime; playerActorId?: string } {
  const { sourceScene, stage, presences, packs } = options;
  const placement = placeScenePresences(
    sourceScene,
    presences.actorsInScene(sourceScene.scene_id),
    options.spawnOverrides,
  );
  const scene = ensureSceneSpawnCapacity(
    placement.scene,
    stage.actors.length,
    stage.actors.map(
      (actor) => placement.spawnOverrides[actor.instance_id] ?? actor.spawn_id,
    ),
  );
  const runtime = new StageRuntime(scene);
  const playerActorId = stage.actors.find((actor) => actor.player)?.instance_id;
  const assignedSpawns = assignStageSpawns(stage.actors, scene, placement.spawnOverrides);
  for (const [index, actor] of stage.actors.entries()) {
    const pack = packs[index];
    if (!pack) throw new Error(`缺少角色包：${actor.bundle_id}`);
    runtime.spawnActor({
      actorId: actor.instance_id,
      characterPack: pack,
      spawnId: assignedSpawns[actor.instance_id] ?? actor.spawn_id,
      controlOwner: actor.control_owner,
    });
  }
  const followBindings = uniqueFollowBindings([
    ...presences.followBindingsInScene(scene.scene_id),
    ...(options.followBindings ?? []),
  ]);
  for (const binding of followBindings) {
    if (!stage.actors.some((actor) => actor.instance_id === binding.actorId)) continue;
    if (!stage.actors.some((actor) => actor.instance_id === binding.targetActorId)) continue;
    runtime.execute({
      id: options.nextCommandId("portal-follow"),
      type: "actor.follow",
      actor_id: binding.actorId,
      target_actor_id: binding.targetActorId,
      distance_tiles: binding.distanceTiles,
      preferred_side: binding.targetActorId === playerActorId ? "above" : "nearest",
      source: "system",
      policy: "replace",
    });
  }
  return {
    scene,
    runtime,
    ...(playerActorId === undefined ? {} : { playerActorId }),
  };
}

function uniqueFollowBindings(bindings: WorldFollowBinding[]): WorldFollowBinding[] {
  return [...new Map(bindings.map((binding) => [binding.actorId, binding])).values()];
}
