import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Position {
  x: number;
  y: number;
}

interface Spawn {
  id: string;
  position: Position;
  facing?: "up" | "down" | "left" | "right";
}

interface MapScene {
  schema_version: "map_scene.v1";
  scene_id: string;
  display_name: string;
  description?: string;
  map: { width: number; height: number; tile_size: number };
  tileset: {
    id: string;
    image: string;
    tile_width: number;
    tile_height: number;
    columns: number;
    tile_count: number;
  };
  layers: Array<{ name: string; data: number[] }>;
  blocked_tiles: Position[];
  landmarks?: Array<{
    id: string;
    display_name: string;
    kind: string;
    bounds: { x: number; y: number; width: number; height: number };
    render_mode?: string;
  }>;
  zones?: Array<{
    id: string;
    display_name: string;
    kind?: string;
    description?: string;
    tags?: string[];
    bounds: { x: number; y: number; width: number; height: number };
  }>;
  anchors?: Array<{
    id: string;
    display_name: string;
    description?: string;
    tags?: string[];
    position: Position;
    facing?: "up" | "down" | "left" | "right";
    slots?: Array<{ id: string; position: Position; facing?: "up" | "down" | "left" | "right" }>;
    interactions?: string[];
  }>;
  spawns: Spawn[];
  portals?: Array<{
    id: string;
    position: Position;
    target_scene_id: string;
    target_spawn_id: string;
  }>;
  activity_paths?: Array<{
    id: string;
    activity_id: string;
    anchor_id?: string;
    loop?: boolean;
    points: Position[];
  }>;
}

interface MapWorld {
  schema_version: "map_world.v1";
  world_id: string;
  display_name: string;
  locations: Array<{
    id: string;
    scene_id: string;
    display_name: string;
    status: "playable" | "planned";
    map_position?: Position;
  }>;
  connections: Array<{
    from: string;
    to: string;
    kind: "walk" | "portal" | "door" | "transit";
  }>;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(
  process.argv[2] ?? resolve(repositoryRoot, "../chibi_weaver/map-lab"),
);
const contentRoot = resolve(repositoryRoot, "content");
const sourceScenesRoot = resolve(sourceRoot, "scenes");
const targetScenesRoot = resolve(contentRoot, "scenes");

const world = await readJson<MapWorld>(resolve(sourceRoot, "worlds/tracen/world.json"));
if (world.schema_version !== "map_world.v1") {
  throw new Error(`Unsupported MapWeaver world schema: ${world.schema_version}`);
}

const scenes = new Map<string, { directoryName: string; scene: MapScene }>();
for (const entry of await readdir(sourceScenesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const scene = await readJson<MapScene>(resolve(sourceScenesRoot, entry.name, "scene.json"));
  if (scene.schema_version !== "map_scene.v1") continue;
  scenes.set(scene.scene_id, { directoryName: entry.name, scene });
}

for (const location of world.locations) {
  const source = scenes.get(location.scene_id);
  if (!source) throw new Error(`World location has no MapWeaver scene: ${location.scene_id}`);
  const targetDirectory = resolve(targetScenesRoot, source.directoryName);
  await mkdir(targetDirectory, { recursive: true });
  await writeJson(resolve(targetDirectory, "scene.map.json"), source.scene);
  await writeJson(resolve(targetDirectory, "scene.json"), compileScene(source.scene));
  await copyOptional(
    resolve(sourceScenesRoot, source.directoryName, "scene-plan.yaml"),
    resolve(targetDirectory, "scene-plan.yaml"),
  );
  console.log(`Synced map ${source.scene.scene_id}`);
}

await copyDirectory(
  resolve(sourceRoot, "tilesets/tracen-campus"),
  resolve(contentRoot, "tilesets/tracen-campus"),
);

await mkdir(resolve(contentRoot, "worlds/tracen"), { recursive: true });
await writeJson(resolve(contentRoot, "worlds/tracen/world.map.json"), world);
await writeJson(resolve(contentRoot, "worlds/tracen/world.json"), {
  schema_version: "world_pack.v1",
  world_id: world.world_id,
  display_name: world.display_name,
  description: "由 chibi_weaver MapWeaver 单向同步的特雷森学院场景拓扑。",
  locations: world.locations.map((location) => ({
    id: location.id,
    display_name: location.display_name,
    type: "campus_area",
    description: "",
    tags: [],
    scene_id: location.scene_id,
    status: location.status,
    ...(location.map_position ? { map_position: location.map_position } : {}),
  })),
  connections: world.connections,
});

const stages = world.locations
  .filter((location) => location.status === "playable")
  .map((location) => {
    const source = scenes.get(location.scene_id);
    if (!source) throw new Error(`Missing scene for stage: ${location.scene_id}`);
    const trainerSpawn =
      source.scene.spawns.find((spawn) => spawn.id === "trainer_start") ??
      source.scene.spawns[1] ??
      source.scene.spawns[0];
    const actorSpawn = source.scene.spawns.find((spawn) => spawn.id !== trainerSpawn?.id);
    if (!trainerSpawn || !actorSpawn) {
      throw new Error(`${location.scene_id} needs two distinct spawns for the trainer and actor`);
    }
    const fileName = `${source.directoryName}.stage.json`;
    return {
      registry: {
        stage_id: `${location.id}_stage`,
        scene_id: location.scene_id,
        display_name: location.display_name,
        definition_path: `stages/${fileName}`,
      },
      fileName,
      definition: {
        schema_version: "stage_definition.v1",
        stage_id: `${location.id}_stage`,
        display_name: location.display_name,
        scene_path: `scenes/${source.directoryName}/scene.json`,
        actors: [
          {
            instance_id: "trainer",
            bundle_id: "trainer",
            spawn_id: trainerSpawn.id,
            control_owner: "player",
            player: true,
          },
          {
            instance_id: "uma_admire_vega",
            bundle_id: "admire-vega-uniform",
            spawn_id: actorSpawn.id,
            control_owner: "agent",
            player: false,
          },
        ],
      },
    };
  });

await mkdir(resolve(contentRoot, "stages"), { recursive: true });
for (const stage of stages) {
  await writeJson(resolve(contentRoot, "stages", stage.fileName), stage.definition);
}
const defaultStage = stages.find((stage) => stage.registry.scene_id === "tracen_student_plaza") ?? stages[0];
if (!defaultStage) throw new Error("MapWeaver world has no playable stages");
await writeJson(resolve(contentRoot, "stages/registry.json"), {
  schema_version: "stage_registry.v1",
  default_definition_path: defaultStage.registry.definition_path,
  stages: stages.map((stage) => stage.registry),
});

console.log(`Synced ${stages.length} playable stages from ${sourceRoot}`);

function compileScene(scene: MapScene): Record<string, unknown> {
  return {
    schema_version: "scene_pack.v1",
    scene_id: scene.scene_id,
    display_name: scene.display_name,
    description: scene.description ?? "",
    source: { format: scene.schema_version, path: "scene.map.json" },
    map: {
      tile_size: scene.map.tile_size,
      width: scene.map.width,
      height: scene.map.height,
      background_color: "#6f9f75",
    },
    tileset: scene.tileset,
    layers: scene.layers,
    landmarks: scene.landmarks ?? [],
    navigation: { blocked_tiles: scene.blocked_tiles },
    zones: (scene.zones ?? []).map((zone) => ({
      id: zone.id,
      display_name: zone.display_name,
      type: zone.kind ?? "",
      description: zone.description ?? "",
      tags: zone.tags ?? [],
      bounds: zone.bounds,
    })),
    surfaces: [],
    props: [],
    anchors: (scene.anchors ?? []).map((anchor) => ({
      id: anchor.id,
      display_name: anchor.display_name,
      description: anchor.description ?? "",
      tags: anchor.tags ?? [],
      position: anchor.position,
      ...(anchor.facing ? { facing: anchor.facing } : {}),
      slots: anchor.slots ?? [],
      interactions: anchor.interactions ?? [],
    })),
    spawns: scene.spawns,
    portals: scene.portals ?? [],
    activity_paths: scene.activity_paths ?? [],
  };
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const targetPath = resolve(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) await copyFile(sourcePath, targetPath);
  }
}

async function copyOptional(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
