import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  base20CharacterPackSchema,
  characterRegistrySchema,
  type Base20CharacterPack,
  type CharacterRegistryEntry,
} from "../packages/contracts/src/index";
import {
  readPngSize,
  validateCharacterBundle,
} from "../packages/sceneweaver/src/validate-character-bundle";

interface BundleIdentity {
  bundleId: string;
  characterId: string;
  outfit: "uniform" | "race-outfit" | "trainer";
  role: CharacterRegistryEntry["role"];
}

interface PreparedBundle {
  identity: BundleIdentity;
  pack: Base20CharacterPack;
  actor: Record<string, unknown>;
  atlas: Record<string, unknown>;
  image: Uint8Array;
  sourceActorPath: string;
}

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const dryRun = arguments_.includes("--dry-run");
const sourceArgument = arguments_.find((argument) => !argument.startsWith("--"));
const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(projectRoot, sourceArgument ?? "../chibi_weaver/output");
const charactersRoot = resolve(projectRoot, "content/characters");

const relativeFiles = await readdir(sourceRoot, { recursive: true });
const runtimeSuffix = `${sep}runtime${sep}actor.json`;
const actorPaths = relativeFiles
  .filter(
    (path) =>
      path === `runtime${sep}actor.json` || path.endsWith(runtimeSuffix),
  )
  .sort();

const bundles: PreparedBundle[] = [];
let skippedNonBase20 = 0;

for (const relativeActorPath of actorPaths) {
  const actorPath = resolveWithin(sourceRoot, relativeActorPath, "Actor manifest");
  const rawActor = JSON.parse(await readFile(actorPath, "utf8")) as unknown;
  const parsed = base20CharacterPackSchema.safeParse(rawActor);
  if (!parsed.success) {
    skippedNonBase20 += 1;
    continue;
  }

  const pack = parsed.data;
  const sourceDirectory = dirname(actorPath);
  const atlasPath = resolveWithin(sourceDirectory, pack.atlas.data, "Actor atlas");
  const imagePath = resolveWithin(sourceDirectory, pack.atlas.image, "Actor image");
  const [rawAtlas, image] = await Promise.all([
    readFile(atlasPath, "utf8").then((text) => JSON.parse(text) as unknown),
    readFile(imagePath),
  ]);
  validateCharacterBundle(pack, rawAtlas, readPngSize(image));

  const atlas = requireRecord(rawAtlas, `${relativeActorPath}: atlas`);
  const meta = requireRecord(atlas.meta, `${relativeActorPath}: atlas.meta`);
  bundles.push({
    identity: deriveIdentity(pack),
    pack,
    actor: {
      ...requireRecord(rawActor, `${relativeActorPath}: actor`),
      display_name: cleanDisplayName(pack.display_name),
      atlas: { image: "atlas.png", data: "atlas.json" },
    },
    atlas: { ...atlas, meta: { ...meta, image: "atlas.png" } },
    image,
    sourceActorPath: actorPath,
  });
}

assertUniqueBundles(bundles);
assertCompleteOutfits(bundles);

const registryEntries = bundles
  .map<CharacterRegistryEntry>((bundle) => ({
    bundle_id: bundle.identity.bundleId,
    actor_path: `characters/${bundle.identity.bundleId}/actor.json`,
    role: bundle.identity.role,
    animation_profile: "base20",
  }))
  .sort((left, right) => left.bundle_id.localeCompare(right.bundle_id));
const registry = characterRegistrySchema.parse({
  schema_version: "character_registry.v1",
  characters: registryEntries,
});

if (!dryRun) {
  await Promise.all(
    bundles.map(async (bundle) => {
      const targetDirectory = resolveWithin(
        charactersRoot,
        bundle.identity.bundleId,
        "Character target",
      );
      await mkdir(targetDirectory, { recursive: true });
      await Promise.all([
        writeFile(
          resolve(targetDirectory, "actor.json"),
          `${JSON.stringify(bundle.actor, null, 2)}\n`,
          "utf8",
        ),
        writeFile(
          resolve(targetDirectory, "atlas.json"),
          `${JSON.stringify(bundle.atlas, null, 2)}\n`,
          "utf8",
        ),
        writeFile(resolve(targetDirectory, "atlas.png"), bundle.image),
      ]);
    }),
  );
  await writeFile(
    resolve(charactersRoot, "registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
}

const characterIds = new Set(
  bundles
    .filter((bundle) => bundle.identity.outfit !== "trainer")
    .map((bundle) => bundle.identity.characterId),
);
console.log(
  `${dryRun ? "Validated" : "Synced"} ${bundles.length} base20 bundles: ` +
    `${characterIds.size} characters × 2 outfits + trainer; ` +
    `skipped ${skippedNonBase20} non-base20 runtime bundles.`,
);

function deriveIdentity(pack: Base20CharacterPack): BundleIdentity {
  if (pack.outfit_id === "trainer_uniform") {
    if (!/^trainer_v\d+$/u.test(pack.actor_id)) {
      throw new Error(`Unexpected trainer actor_id: ${pack.actor_id}`);
    }
    return {
      bundleId: "trainer",
      characterId: "trainer",
      outfit: "trainer",
      role: "controller_avatar",
    };
  }

  const outfit = pack.outfit_id === "race_outfit" ? "race-outfit" : pack.outfit_id;
  if (outfit !== "uniform" && outfit !== "race-outfit") {
    throw new Error(`Unsupported base20 outfit ${pack.outfit_id}: ${pack.actor_id}`);
  }
  const actorIdPattern =
    outfit === "uniform"
      ? /^(?<character>.+)_uniform(?:_walk)?_v\d+$/u
      : /^(?<character>.+)_race_outfit_v\d+$/u;
  const characterId = actorIdPattern.exec(pack.actor_id)?.groups?.character;
  if (!characterId) {
    throw new Error(`Cannot derive character ID from ${pack.actor_id}/${pack.outfit_id}`);
  }
  const characterSlug = characterId.replaceAll("_", "-");
  return {
    bundleId: `${characterSlug}-${outfit}`,
    characterId,
    outfit,
    role: "character",
  };
}

function cleanDisplayName(displayName: string): string {
  return displayName.replace(/\s*[（(]完整基础动画[）)]\s*$/u, "").trim();
}

function assertUniqueBundles(bundlesToCheck: PreparedBundle[]): void {
  const seen = new Map<string, string>();
  for (const bundle of bundlesToCheck) {
    const previous = seen.get(bundle.identity.bundleId);
    if (previous) {
      throw new Error(
        `Duplicate base20 bundle ${bundle.identity.bundleId}: ` +
          `${previous} and ${bundle.sourceActorPath}`,
      );
    }
    seen.set(bundle.identity.bundleId, bundle.sourceActorPath);
  }
}

function assertCompleteOutfits(bundlesToCheck: PreparedBundle[]): void {
  const outfitsByCharacter = new Map<string, Set<string>>();
  for (const bundle of bundlesToCheck) {
    if (bundle.identity.outfit === "trainer") continue;
    const outfits = outfitsByCharacter.get(bundle.identity.characterId) ?? new Set<string>();
    outfits.add(bundle.identity.outfit);
    outfitsByCharacter.set(bundle.identity.characterId, outfits);
  }
  for (const [characterId, outfits] of outfitsByCharacter) {
    if (!outfits.has("uniform") || !outfits.has("race-outfit") || outfits.size !== 2) {
      throw new Error(
        `Character ${characterId} must provide exactly uniform and race-outfit base20 bundles`,
      );
    }
  }
  if (!bundlesToCheck.some((bundle) => bundle.identity.outfit === "trainer")) {
    throw new Error("The base20 roster must include trainer_v02");
  }
}

function resolveWithin(root: string, path: string, label: string): string {
  const resolvedPath = resolve(root, path);
  const relativePath = relative(root, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath === "") {
    throw new Error(`${label} must stay inside ${root}: ${path}`);
  }
  return resolvedPath;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}
