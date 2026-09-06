import {
  scenePackSchema,
  stageDefinitionSchema,
  worldPackSchema,
  type ScenePack,
  type StageRegistryEntry,
  type WorldPack,
} from "@uma-stage/contracts";
import { WorldNavigation } from "@uma-stage/core";

export interface WorldOverviewData {
  world: WorldPack;
  scenes: Map<string, ScenePack>;
  navigation: WorldNavigation;
}

export async function loadWorldOverview(
  stages: StageRegistryEntry[],
  readContent: (path: string) => Promise<unknown>,
): Promise<WorldOverviewData> {
  const [world, scenes] = await Promise.all([
    readContent("worlds/tracen/world.json").then((value) => worldPackSchema.parse(value)),
    Promise.all(stages.map(async (stage) => {
      const definition = stageDefinitionSchema.parse(await readContent(stage.definition_path));
      return scenePackSchema.parse(await readContent(definition.scene_path));
    })),
  ]);
  return {
    world,
    scenes: new Map(scenes.map((scene) => [scene.scene_id, scene])),
    navigation: new WorldNavigation(world, scenes),
  };
}

export function connectionKey(from: string, to: string): string {
  return JSON.stringify([from, to].sort());
}

export function worldGraph(data: WorldOverviewData) {
  const locations = data.world.locations.filter((location) => location.scene_id && data.scenes.has(location.scene_id));
  const positions = locations.map((location, index) => location.map_position ?? { x: index % 4, y: Math.floor(index / 4) });
  const minX = Math.min(0, ...positions.map((position) => position.x));
  const minY = Math.min(0, ...positions.map((position) => position.y));
  const nodes = locations.map((location, index) => ({
    id: location.scene_id!,
    name: location.display_name,
    x: 96 + (positions[index]!.x - minX) * 180,
    y: 56 + (positions[index]!.y - minY) * 104,
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = new Map<string, { key: string; from: typeof nodes[number]; to: typeof nodes[number]; bidirectional: boolean }>();
  // The diagram and route finder both use actual portals, not merely planned world connections.
  for (const scene of data.scenes.values()) {
    for (const portal of scene.portals) {
      const from = byId.get(scene.scene_id);
      const to = byId.get(portal.target_scene_id);
      if (!from || !to || from.id === to.id) continue;
      const key = connectionKey(from.id, to.id);
      if (edges.has(key)) continue;
      edges.set(key, {
        key, from, to,
        bidirectional: data.scenes.get(to.id)?.portals.some((candidate) => candidate.target_scene_id === from.id) ?? false,
      });
    }
  }
  return {
    nodes,
    edges: [...edges.values()],
    width: Math.max(360, ...nodes.map((node) => node.x + 96)),
    height: Math.max(220, ...nodes.map((node) => node.y + 56)),
  };
}

export function portalLocation(scene: ScenePack, position: { x: number; y: number }): string {
  const horizontal = position.x === 0 ? "左侧边界" : position.x === scene.map.width - 1 ? "右侧边界" : "";
  const vertical = position.y === 0 ? "上方边界" : position.y === scene.map.height - 1 ? "下方边界" : "";
  if (horizontal || vertical) return [horizontal, vertical].filter(Boolean).join(" / ");
  const x = position.x / scene.map.width;
  const y = position.y / scene.map.height;
  return `${y < 0.36 ? "上方" : y > 0.64 ? "下方" : "中部"}${x < 0.36 ? "偏左" : x > 0.64 ? "偏右" : "中央"}入口`;
}
