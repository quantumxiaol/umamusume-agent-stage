import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { characterPackSchema } from "../packages/contracts/src/index";
import {
  readPngSize,
  validateCharacterBundle,
} from "../packages/sceneweaver/src/validate-character-bundle";

const [sourceArgument, targetArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!sourceArgument || !targetArgument) {
  throw new Error(
    "Usage: pnpm import:actor -- <source actor.json> <content/characters/target-directory>",
  );
}

const projectRoot = resolve(import.meta.dirname, "..");
const charactersRoot = resolve(projectRoot, "content/characters");
const sourceActorPath = resolve(sourceArgument);
const sourceDirectory = dirname(sourceActorPath);
const targetDirectory = resolve(targetArgument);
assertInside(charactersRoot, targetDirectory, "Import target");

const sourcePack = characterPackSchema.parse(
  JSON.parse(await readFile(sourceActorPath, "utf8")) as unknown,
);
const sourceAtlasPath = resolve(sourceDirectory, sourcePack.atlas.data);
const sourceImagePath = resolve(sourceDirectory, sourcePack.atlas.image);
const [atlasInput, image] = await Promise.all([
  readFile(sourceAtlasPath, "utf8").then((text) => JSON.parse(text) as unknown),
  readFile(sourceImagePath),
]);
validateCharacterBundle(sourcePack, atlasInput, readPngSize(image));

const atlas = requireRecord(atlasInput, "atlas");
const meta = requireRecord(atlas.meta, "atlas.meta");
const importedPack = {
  ...sourcePack,
  atlas: { image: "atlas.png", data: "atlas.json" },
};
const importedAtlas = {
  ...atlas,
  meta: { ...meta, image: "atlas.png" },
};

await mkdir(targetDirectory, { recursive: true });
await Promise.all([
  copyFile(sourceImagePath, resolve(targetDirectory, "atlas.png")),
  writeFile(
    resolve(targetDirectory, "actor.json"),
    `${JSON.stringify(importedPack, null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(targetDirectory, "atlas.json"),
    `${JSON.stringify(importedAtlas, null, 2)}\n`,
    "utf8",
  ),
]);

console.log(
  `Imported ${sourcePack.actor_id}: ${sourceImagePath} -> ${targetDirectory} ` +
    `(${readPngSize(image).width}x${readPngSize(image).height})`,
);

function assertInside(root: string, target: string, label: string): void {
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath === "") {
    throw new Error(`${label} must be a child directory of ${root}`);
  }
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}
