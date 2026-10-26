import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stageRegistrySchema } from "@uma-stage/contracts";
import { connectionKey, loadWorldOverview, portalLocation, worldGraph } from "./world-overview";

const contentRoot = new URL("../../../content/", import.meta.url);
const readContent = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, contentRoot), "utf8"));
const registry = stageRegistrySchema.parse(await readContent("stages/registry.json"));
const data = await loadWorldOverview(registry.stages, readContent);

describe("world overview", () => {
  it("loads all 19 scenes and derives edges from real portals rather than schematic connections", () => {
    const graph = worldGraph({ ...data, world: { ...data.world, connections: [] } });
    expect(graph.nodes).toHaveLength(19);
    const realEdges = new Set([...data.scenes.values()].flatMap((scene) => scene.portals.map((portal) => connectionKey(scene.scene_id, portal.target_scene_id))));
    expect(new Set(graph.edges.map((edge) => edge.key))).toEqual(realEdges);
    expect(graph.edges.every((edge) => edge.bidirectional)).toBe(true);
  });

  it("lists the training ground exits and gives an actual multi-map route", () => {
    const scene = data.scenes.get("tracen_training_ground")!;
    expect(scene.portals.map((portal) => [portal.target_scene_id, portalLocation(scene, portal.position)])).toEqual([
      ["tracen_student_plaza", "下方边界"],
      ["tracen_indoor_training_hall", "右侧边界"],
    ]);
    const route = data.navigation.findRoute("tracen_indoor_training_hall", "tracen_trainer_office")!;
    expect(route.steps.map((step) => step.target_scene_id)).toEqual([
      "tracen_training_ground", "tracen_student_plaza", "tracen_school_courtyard", "tracen_main_school_interior", "tracen_trainer_office",
    ]);
    for (const step of route.steps) {
      expect(data.scenes.get(step.from_scene_id)!.portals.find((portal) => portal.id === step.portal_id)?.position).toEqual(step.exit_position);
    }
    expect(data.navigation.findRoute(scene.scene_id, scene.scene_id)?.steps).toEqual([]);
  });

  it("uses the real plaza portal for travel to the training ground", () => {
    expect(data.navigation.findRoute("tracen_student_plaza", "tracen_training_ground")?.steps).toEqual([
      {
        from_scene_id: "tracen_student_plaza",
        portal_id: "to_training_ground",
        exit_position: { x: 47, y: 16 },
        target_scene_id: "tracen_training_ground",
        target_spawn_id: "from_plaza",
      },
    ]);
  });

  it("has routes between every playable scene and valid destination entrances", () => {
    for (const source of data.scenes.values()) {
      for (const target of data.scenes.keys()) {
        expect(data.navigation.findRoute(source.scene_id, target)).not.toBeNull();
      }
      for (const portal of source.portals) {
        expect(data.scenes.get(portal.target_scene_id)?.spawns.some((spawn) => spawn.id === portal.target_spawn_id)).toBe(true);
      }
    }
  });

  it("does not invent a return connection for a one-way portal", () => {
    const scene = data.scenes.get("tracen_indoor_training_hall")!;
    const scenes = new Map(data.scenes);
    scenes.set(scene.scene_id, { ...scene, portals: [] });
    const edge = worldGraph({ ...data, scenes }).edges.find((candidate) => candidate.key === connectionKey(scene.scene_id, "tracen_training_ground"));
    expect(edge?.bidirectional).toBe(false);
  });

  it("reports asset errors instead of quietly showing an incomplete world", async () => {
    await expect(loadWorldOverview(registry.stages, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  });
});
