import type { ScenePack, TilePosition, WorldPack } from "@uma-stage/contracts";

export interface WorldRouteStep {
  from_scene_id: string;
  portal_id: string;
  exit_position: TilePosition;
  target_scene_id: string;
  target_spawn_id: string;
}

export interface WorldRoutePlan {
  from_scene_id: string;
  target_scene_id: string;
  steps: WorldRouteStep[];
}

export interface WorldAnchorDestination {
  scene_id: string;
  anchor_id: string;
  route: WorldRoutePlan;
}

export class WorldNavigation {
  readonly #scenes = new Map<string, ScenePack>();
  readonly #playableScenes = new Set<string>();

  constructor(readonly world: WorldPack, scenes: Iterable<ScenePack>) {
    for (const scene of scenes) this.#scenes.set(scene.scene_id, scene);
    for (const location of world.locations) {
      if (location.status !== "playable" || !location.scene_id) continue;
      this.#playableScenes.add(location.scene_id);
      if (!this.#scenes.has(location.scene_id)) {
        throw new Error(`Playable world location has no scene pack: ${location.scene_id}`);
      }
    }
  }

  findRoute(fromSceneId: string, targetSceneId: string): WorldRoutePlan | null {
    if (!this.#playableScenes.has(fromSceneId)) {
      throw new Error(`Unknown playable source scene: ${fromSceneId}`);
    }
    if (!this.#playableScenes.has(targetSceneId)) {
      throw new Error(`Unknown playable target scene: ${targetSceneId}`);
    }
    if (fromSceneId === targetSceneId) {
      return { from_scene_id: fromSceneId, target_scene_id: targetSceneId, steps: [] };
    }

    const queue: string[] = [fromSceneId];
    const visited = new Set(queue);
    const previous = new Map<string, WorldRouteStep>();
    while (queue.length > 0) {
      const sceneId = queue.shift();
      if (!sceneId) break;
      const scene = this.#scenes.get(sceneId);
      if (!scene) continue;
      for (const portal of scene.portals) {
        if (!this.#playableScenes.has(portal.target_scene_id) || visited.has(portal.target_scene_id)) {
          continue;
        }
        const step: WorldRouteStep = {
          from_scene_id: sceneId,
          portal_id: portal.id,
          exit_position: { ...portal.position },
          target_scene_id: portal.target_scene_id,
          target_spawn_id: portal.target_spawn_id,
        };
        previous.set(portal.target_scene_id, step);
        if (portal.target_scene_id === targetSceneId) {
          return {
            from_scene_id: fromSceneId,
            target_scene_id: targetSceneId,
            steps: reconstructSteps(fromSceneId, targetSceneId, previous),
          };
        }
        visited.add(portal.target_scene_id);
        queue.push(portal.target_scene_id);
      }
    }
    return null;
  }

  findAnchor(fromSceneId: string, anchorId: string): WorldAnchorDestination | null {
    const candidates = [...this.#scenes.values()].filter(
      (scene) =>
        this.#playableScenes.has(scene.scene_id) &&
        scene.anchors.some((anchor) => anchor.id === anchorId),
    );
    let best: WorldAnchorDestination | null = null;
    for (const scene of candidates) {
      const route = this.findRoute(fromSceneId, scene.scene_id);
      if (!route || (best && best.route.steps.length <= route.steps.length)) continue;
      best = { scene_id: scene.scene_id, anchor_id: anchorId, route };
    }
    return best;
  }
}

function reconstructSteps(
  fromSceneId: string,
  targetSceneId: string,
  previous: Map<string, WorldRouteStep>,
): WorldRouteStep[] {
  const steps: WorldRouteStep[] = [];
  let current = targetSceneId;
  while (current !== fromSceneId) {
    const step = previous.get(current);
    if (!step) return [];
    steps.push(step);
    current = step.from_scene_id;
  }
  return steps.reverse();
}
