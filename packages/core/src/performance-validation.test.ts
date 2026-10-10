import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  animeStageScriptSchema, characterAgentMappingSchema, characterPackSchema,
  characterRegistrySchema, scenePackSchema, stageDefinitionSchema, stageRegistrySchema,
  type PerformanceScript,
} from "@uma-stage/contracts";
import { compileAnimeStageScript } from "./anime-stage-adapter";
import { compilePerformanceCue } from "./performance-compiler";
import { validatePerformanceScene } from "./performance-validation";
import { StageRuntime } from "./runtime";
import { applyStageCast } from "./stage-cast";
import { assignStageSpawns } from "./spawn-assignment";
import { ensureSceneSpawnCapacity } from "./scene-capacity";
import type { StageTask } from "./task";

const contentRoot = new URL("../../../content/", import.meta.url);
function json(path: string): unknown { return JSON.parse(readFileSync(new URL(path, contentRoot), "utf8")); }
function fixture() {
  const script = compileAnimeStageScript(animeStageScriptSchema.parse(json("performances/admire-vega-starlight.anime.json")));
  const stages = stageRegistrySchema.parse(json("stages/registry.json"));
  const first = script.scenes[0]!;
  const definition = stageDefinitionSchema.parse(json(stages.stages.find((entry) => entry.stage_id === first.stage_id)!.definition_path));
  return { script, stages, first, scene: scenePackSchema.parse(json(definition.scene_path)) };
}

describe("performance content preflight", () => {
  it("validates the built-in show against real scene content", () => {
    const { first, scene } = fixture();
    expect(() => validatePerformanceScene(first, scene)).not.toThrow();
  });

  it("reports exact cue paths for invalid slots, paths, cameras and spawns", () => {
    const { first, scene } = fixture();
    const check = (cue: PerformanceScript["scenes"][number]["beats"][number]["cues"][number]) => {
      expect(() => validatePerformanceScene({ ...first, beats: [{ beat_id: "bad", cues: [cue], wait_for: "all", hold_ms: 0 }] }, scene)).toThrow(`${first.scene_id}/bad/${cue.cue_id}`);
    };
    check({ cue_id: "slot", type: "actor.move_to", role_id: "vega", policy: "replace", target: { type: "anchor", anchor_id: scene.anchors[0]!.id, slot_id: "missing" } });
    check({ cue_id: "path", type: "actor.follow_activity_path", role_id: "vega", policy: "replace", cycles: 1, activity_path_id: "missing" });
    check({ cue_id: "zone", type: "camera.focus_zone", zone_id: "missing", zoom: 1, transition_ms: 100 });
    expect(() => validatePerformanceScene({ ...first, placements: [{ role_id: "vega", spawn_id: "missing" }] }, scene)).toThrow("Unknown spawn");
  });

  it("rejects simultaneous ownership of the one stage camera", () => {
    const { first, scene } = fixture();
    expect(() => validatePerformanceScene({ ...first, beats: [{ beat_id: "cameras", wait_for: "all", hold_ms: 0, cues: [
      { cue_id: "one", type: "camera.overview", transition_ms: 100 },
      { cue_id: "two", type: "camera.overview", transition_ms: 100 },
    ] }] }, scene)).toThrow("Only one camera cue");
  });

  it("completes all built-in show commands with the real cast and navigation", async () => {
    const { script, stages } = fixture();
    const mappings = characterAgentMappingSchema.parse(json("characters/agent-mapping.json"));
    const bundles = characterRegistrySchema.parse(json("characters/registry.json"));
    for (const performanceScene of script.scenes) {
      const entry = stages.stages.find((stage) => stage.stage_id === performanceScene.stage_id)!;
      const definition = applyStageCast(stageDefinitionSchema.parse(json(entry.definition_path)), script.cast.filter((member) => member.character_id !== "trainer").map((member) => ({
        mapping: mappings.characters.find((mapping) => mapping.character_id === member.character_id)!,
        outfit: member.outfit_id === "race_outfit" ? "race_outfit" : "uniform",
      })));
      const bindings = Object.fromEntries(script.cast.map((member) => [member.role_id, member.character_id === "trainer"
        ? definition.actors.find((actor) => actor.player)!.instance_id
        : mappings.characters.find((mapping) => mapping.character_id === member.character_id)!.stage_actor_id]));
      const overrides = Object.fromEntries(performanceScene.placements.filter((placement) => placement.spawn_id).map((placement) => [bindings[placement.role_id]!, placement.spawn_id!]));
      const source = scenePackSchema.parse(json(definition.scene_path));
      validatePerformanceScene(performanceScene, source);
      const scene = ensureSceneSpawnCapacity(source, definition.actors.length, definition.actors.map((actor) => overrides[actor.instance_id] ?? actor.spawn_id));
      const spawns = assignStageSpawns(definition.actors, scene, overrides);
      const runtime = new StageRuntime(scene);
      for (const actor of definition.actors) runtime.spawnActor({ actorId: actor.instance_id, controlOwner: "script", spawnId: spawns[actor.instance_id]!, characterPack: characterPackSchema.parse(json(bundles.characters.find((bundle) => bundle.bundle_id === actor.bundle_id)!.actor_path)) });
      const allTasks: StageTask[] = [];
      const settle = (tasks: StageTask[]) => {
        for (let tick = 0; tick < 30_000 && tasks.some((task) => task.status === "pending" || task.status === "running"); tick++) {
          runtime.tick(50);
          const actors = runtime.snapshot().actors;
          for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
            const a = actors[i]!.position, b = actors[j]!.position;
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(scene.map.tile_size * 0.6 - 0.001);
          }
        }
        expect(tasks.map((task) => task.status)).toEqual(tasks.map(() => "completed"));
      };
      for (const beat of performanceScene.beats) {
        const tasks = beat.cues.flatMap((cue) => {
          const compiled = compilePerformanceCue(cue, bindings);
          if (compiled.kind !== "command") return [];
          const command = compiled.command.type === "dialogue.say" ? { ...compiled.command, duration_ms: 1 } : compiled.command;
          return [runtime.execute(command)];
        });
        allTasks.push(...tasks);
        if (beat.wait_for === "all") settle(tasks);
      }
      settle(allTasks);
      for (const task of allTasks) expect(await task.completion).toMatchObject({ status: "completed" });
    }
  });
});
