import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  animeStageScriptSchema,
  base20CharacterPackSchema,
  characterAgentMappingSchema,
  characterPackSchema,
  characterRegistrySchema,
  performanceScriptSchema,
  scenePackSchema,
  stageDefinitionSchema,
  stageRegistrySchema,
  worldPackSchema,
} from "@uma-stage/contracts";
import { compileAnimeStageScript } from "@uma-stage/core";

import {
  compileTiledScene,
  readPngSize,
  type TiledMap,
  validateCharacterBundle,
} from "./index";

const contentRoot = resolve(import.meta.dirname, "../../../content");
const sceneDirectory = resolve(contentRoot, "scenes");
const entries = await readdir(sceneDirectory, { recursive: true, withFileTypes: true });
const maps = entries.filter((entry) => entry.isFile() && entry.name === "map.tmj");

for (const entry of maps) {
  const mapPath = resolve(entry.parentPath, entry.name);
  const metadataPath = resolve(dirname(mapPath), "scene.meta.json");
  const [map, metadata] = await Promise.all([
    readFile(mapPath, "utf8").then((text) => JSON.parse(text) as TiledMap),
    readFile(metadataPath, "utf8").then((text) => JSON.parse(text) as {
      scene_id: string;
      display_name: string;
      description?: string;
      background_color?: string;
    }),
  ]);
  const scene = compileTiledScene(map, {
    sceneId: metadata.scene_id,
    displayName: metadata.display_name,
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.background_color === undefined
      ? {}
      : { backgroundColor: metadata.background_color }),
    tiledSource: basename(mapPath),
  });
  const output = resolve(dirname(mapPath), "scene.json");
  await writeFile(output, `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  console.log(`Built ${scene.scene_id}: ${output}`);
}

const characterDirectory = resolve(contentRoot, "characters");
const registry = characterRegistrySchema.parse(
  JSON.parse(await readFile(resolve(characterDirectory, "registry.json"), "utf8")) as unknown,
);
const registeredActorPaths = new Set(registry.characters.map((entry) => entry.actor_path));
const packsByBundle = new Map<
  string,
  ReturnType<typeof characterPackSchema.parse>
>();

for (const entry of registry.characters) {
  const actorPath = resolveContentPath(entry.actor_path);
  const bundleDirectory = dirname(actorPath);
  const rawPack = JSON.parse(await readFile(actorPath, "utf8")) as unknown;
  const pack =
    entry.animation_profile === "base20"
      ? base20CharacterPackSchema.parse(rawPack)
      : characterPackSchema.parse(rawPack);
  packsByBundle.set(entry.bundle_id, pack);
  const atlasPath = resolveBundlePath(bundleDirectory, pack.atlas.data);
  const imagePath = resolveBundlePath(bundleDirectory, pack.atlas.image);
  const [atlas, image] = await Promise.all([
    readFile(atlasPath, "utf8").then((text) => JSON.parse(text) as unknown),
    readFile(imagePath),
  ]);
  validateCharacterBundle(pack, atlas, readPngSize(image));
  console.log(`Validated ${entry.animation_profile} character ${pack.actor_id}: ${bundleDirectory}`);
}

const bundleDirectories = (await readdir(characterDirectory, { withFileTypes: true })).filter(
  (entry) => entry.isDirectory(),
);
for (const bundle of bundleDirectories) {
  const actorPath = `characters/${bundle.name}/actor.json`;
  if (!registeredActorPaths.has(actorPath)) {
    throw new Error(`Character bundle is not registered: ${actorPath}`);
  }
}

const registryByBundle = new Map(registry.characters.map((entry) => [entry.bundle_id, entry]));
const agentMapping = characterAgentMappingSchema.parse(
  JSON.parse(await readFile(resolve(characterDirectory, "agent-mapping.json"), "utf8")) as unknown,
);

for (const mapping of agentMapping.characters) {
  const outfits = [
    ["uniform_bundle_id", mapping.uniform_bundle_id, "uniform"],
    ["race_outfit_bundle_id", mapping.race_outfit_bundle_id, "race_outfit"],
  ] as const;
  for (const [field, bundleId, expectedOutfit] of outfits) {
    const registryEntry = registryByBundle.get(bundleId);
    const pack = packsByBundle.get(bundleId);
    if (!registryEntry || !pack) {
      throw new Error(
        `Agent mapping ${mapping.character_id}.${field} references unknown bundle: ${bundleId}`,
      );
    }
    if (registryEntry.role !== "character" || registryEntry.animation_profile !== "base20") {
      throw new Error(`Agent mapping bundle must be a base20 character: ${bundleId}`);
    }
    if (pack.outfit_id !== expectedOutfit) {
      throw new Error(
        `Agent mapping ${mapping.character_id}.${field} expected outfit ${expectedOutfit}, got ${pack.outfit_id}`,
      );
    }
  }
}
console.log(`Validated ${agentMapping.characters.length} Agent character mappings`);

const stagesDirectory = resolve(contentRoot, "stages");
const stageRegistry = stageRegistrySchema.parse(
  JSON.parse(await readFile(resolve(stagesDirectory, "registry.json"), "utf8")) as unknown,
);
const registeredStagePaths = new Set(
  stageRegistry.stages.map((entry) => entry.definition_path),
);
const stageFiles = (await readdir(stagesDirectory, { withFileTypes: true })).filter(
  (entry) => entry.isFile() && entry.name.endsWith(".stage.json"),
);
const scenesById = new Map<string, ReturnType<typeof scenePackSchema.parse>>();
const stagesById = new Map<
  string,
  {
    stage: ReturnType<typeof stageDefinitionSchema.parse>;
    scene: ReturnType<typeof scenePackSchema.parse>;
  }
>();
for (const registryEntry of stageRegistry.stages) {
  const stagePath = resolveContentPath(registryEntry.definition_path);
  const stage = stageDefinitionSchema.parse(
    JSON.parse(await readFile(stagePath, "utf8")) as unknown,
  );
  const scene = scenePackSchema.parse(
    JSON.parse(await readFile(resolveContentPath(stage.scene_path), "utf8")) as unknown,
  );
  if (scene.tileset) {
    const sceneDirectory = dirname(resolveContentPath(stage.scene_path));
    await readFile(resolveContentRelativePath(sceneDirectory, scene.tileset.image));
  }
  if (stage.stage_id !== registryEntry.stage_id || scene.scene_id !== registryEntry.scene_id) {
    throw new Error(
      `Stage registry mismatch for ${registryEntry.definition_path}: ${stage.stage_id}/${scene.scene_id}`,
    );
  }
  scenesById.set(scene.scene_id, scene);
  stagesById.set(stage.stage_id, { stage, scene });
  const spawnIds = new Set(scene.spawns.map((spawn) => spawn.id));
  const spawnById = new Map(scene.spawns.map((spawn) => [spawn.id, spawn]));
  const assignedSpawnPositions = new Map<string, string>();

  for (const actor of stage.actors) {
    if (!registryByBundle.has(actor.bundle_id)) {
      throw new Error(
        `Stage ${stage.stage_id} references unknown character bundle: ${actor.bundle_id}`,
      );
    }
    if (!spawnIds.has(actor.spawn_id)) {
      throw new Error(
        `Stage ${stage.stage_id} references unknown spawn ${actor.spawn_id} in ${scene.scene_id}`,
      );
    }
    const spawn = spawnById.get(actor.spawn_id);
    if (spawn) {
      const position = `${spawn.position.x},${spawn.position.y}`;
      const occupiedBy = assignedSpawnPositions.get(position);
      if (occupiedBy) {
        throw new Error(
          `Stage ${stage.stage_id} overlaps actor spawns: ${occupiedBy}/${actor.instance_id}`,
        );
      }
      assignedSpawnPositions.set(position, actor.instance_id);
    }
  }
  console.log(`Validated stage ${stage.stage_id}: ${stagePath}`);
}

for (const stageFile of stageFiles) {
  const definitionPath = `stages/${stageFile.name}`;
  if (!registeredStagePaths.has(definitionPath)) {
    throw new Error(`Stage definition is not registered: ${definitionPath}`);
  }
}

for (const scene of scenesById.values()) {
  for (const portal of scene.portals) {
    const targetScene = scenesById.get(portal.target_scene_id);
    if (!targetScene) {
      throw new Error(
        `Portal ${scene.scene_id}/${portal.id} targets an unregistered scene: ${portal.target_scene_id}`,
      );
    }
    if (!targetScene.spawns.some((spawn) => spawn.id === portal.target_spawn_id)) {
      throw new Error(
        `Portal ${scene.scene_id}/${portal.id} targets an unknown spawn: ${portal.target_scene_id}/${portal.target_spawn_id}`,
      );
    }
  }
}

const performanceDirectory = resolve(contentRoot, "performances");
const performanceFiles = (await readdir(performanceDirectory, { withFileTypes: true })).filter(
  (entry) =>
    entry.isFile() &&
    (entry.name.endsWith(".performance.json") || entry.name.endsWith(".anime.json")),
);
const mappedCharacterIds = new Set(
  agentMapping.characters.map((mapping) => mapping.character_id),
);
for (const entry of performanceFiles) {
  const performancePath = resolve(performanceDirectory, entry.name);
  const rawPerformance = JSON.parse(await readFile(performancePath, "utf8")) as unknown;
  const performance = entry.name.endsWith(".anime.json")
    ? compileAnimeStageScript(animeStageScriptSchema.parse(rawPerformance))
    : performanceScriptSchema.parse(rawPerformance);
  for (const member of performance.cast) {
    if (member.character_id === "trainer") {
      if (member.outfit_id !== "default") {
        throw new Error(
          `Performance ${performance.performance_id} trainer outfit must be default`,
        );
      }
    } else {
      if (!mappedCharacterIds.has(member.character_id)) {
        throw new Error(
          `Performance ${performance.performance_id} references unmapped character: ${member.character_id}`,
        );
      }
      if (member.outfit_id !== "uniform" && member.outfit_id !== "race_outfit") {
        throw new Error(
          `Performance ${performance.performance_id} has unsupported Stage outfit: ${member.character_id}/${member.outfit_id}`,
        );
      }
    }
  }
  for (const performanceScene of performance.scenes) {
    const resolvedStage = stagesById.get(performanceScene.stage_id);
    if (!resolvedStage) {
      throw new Error(
        `Performance ${performance.performance_id} references unknown stage: ${performanceScene.stage_id}`,
      );
    }
    const { scene } = resolvedStage;
    const spawnIds = new Set(scene.spawns.map((spawn) => spawn.id));
    const anchorIds = new Set(scene.anchors.map((anchor) => anchor.id));
    const zoneIds = new Set(scene.zones.map((zone) => zone.id));
    const activityPathIds = new Set(scene.activity_paths.map((path) => path.id));
    for (const placement of performanceScene.placements) {
      if (placement.spawn_id && !spawnIds.has(placement.spawn_id)) {
        throw new Error(
          `Performance ${performance.performance_id}/${performanceScene.scene_id} references unknown spawn: ${placement.spawn_id}`,
        );
      }
    }
    for (const beat of performanceScene.beats) {
      for (const cue of beat.cues) {
        if (
          cue.type === "actor.move_to" &&
          cue.target.type === "anchor" &&
          !anchorIds.has(cue.target.anchor_id)
        ) {
          throw new Error(
            `Performance cue ${cue.cue_id} references unknown anchor: ${cue.target.anchor_id}`,
          );
        }
        if (
          cue.type === "actor.follow_activity_path" &&
          !activityPathIds.has(cue.activity_path_id)
        ) {
          throw new Error(
            `Performance cue ${cue.cue_id} references unknown activity path: ${cue.activity_path_id}`,
          );
        }
        if (cue.type === "camera.focus_anchor" && !anchorIds.has(cue.anchor_id)) {
          throw new Error(
            `Performance cue ${cue.cue_id} references unknown anchor: ${cue.anchor_id}`,
          );
        }
        if (cue.type === "camera.focus_zone" && !zoneIds.has(cue.zone_id)) {
          throw new Error(
            `Performance cue ${cue.cue_id} references unknown zone: ${cue.zone_id}`,
          );
        }
      }
    }
  }
  console.log(`Validated performance ${performance.performance_id}: ${performancePath}`);
}

const world = worldPackSchema.parse(
  JSON.parse(await readFile(resolve(contentRoot, "worlds/tracen/world.json"), "utf8")) as unknown,
);
const locationIds = new Set<string>();
for (const location of world.locations) {
  if (locationIds.has(location.id)) throw new Error(`Duplicate world location: ${location.id}`);
  locationIds.add(location.id);
  if (location.status === "playable" && (!location.scene_id || !scenesById.has(location.scene_id))) {
    throw new Error(`Playable world location has no registered scene: ${location.id}`);
  }
}
for (const connection of world.connections) {
  if (!locationIds.has(connection.from) || !locationIds.has(connection.to)) {
    throw new Error(`World connection references an unknown location: ${connection.from}/${connection.to}`);
  }
}
console.log(`Validated world ${world.world_id}: ${world.locations.length} locations`);

function resolveBundlePath(bundleDirectory: string, path: string): string {
  const resolvedPath = resolve(bundleDirectory, path);
  const relativePath = relative(bundleDirectory, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`CharacterBundle assets must stay inside their bundle: ${path}`);
  }
  return resolvedPath;
}

function resolveContentRelativePath(directory: string, path: string): string {
  const resolvedPath = resolve(directory, path);
  const relativePath = relative(contentRoot, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Scene asset must stay inside the content root: ${path}`);
  }
  return resolvedPath;
}

function resolveContentPath(path: string): string {
  const resolvedPath = resolve(contentRoot, path);
  const relativePath = relative(contentRoot, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Content path must stay inside the content root: ${path}`);
  }
  return resolvedPath;
}
