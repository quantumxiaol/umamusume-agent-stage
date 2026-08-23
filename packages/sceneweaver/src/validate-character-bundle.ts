import type { CharacterPack } from "@uma-stage/contracts";

export interface ImageSize {
  width: number;
  height: number;
}

interface FrameRectangle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function validateCharacterBundle(
  pack: CharacterPack,
  atlasInput: unknown,
  imageSize: ImageSize,
): void {
  const atlas = requireRecord(atlasInput, "atlas");
  const frames = requireRecord(atlas.frames, "atlas.frames");

  const referencedFrames = new Set<string>();
  for (const animation of Object.values(pack.animations)) {
    for (const directionalFrames of Object.values(animation.directions)) {
      for (const frame of directionalFrames ?? []) referencedFrames.add(frame);
    }
  }

  for (const frameName of referencedFrames) {
    if (!(frameName in frames)) {
      throw new Error(`CharacterPack references missing atlas frame: ${frameName}`);
    }
  }

  for (const [frameName, frameEntry] of Object.entries(frames)) {
    const entry = requireRecord(frameEntry, `atlas.frames.${frameName}`);
    const rectangle = parseFrameRectangle(entry.frame, frameName);
    if (
      rectangle.x + rectangle.w > imageSize.width ||
      rectangle.y + rectangle.h > imageSize.height
    ) {
      throw new Error(
        `Atlas frame ${frameName} exceeds image bounds: ` +
          `${rectangle.x},${rectangle.y},${rectangle.w},${rectangle.h} ` +
          `outside ${imageSize.width}x${imageSize.height}`,
      );
    }
  }

  const meta = isRecord(atlas.meta) ? atlas.meta : undefined;
  const declaredSize = meta && isRecord(meta.size) ? meta.size : undefined;
  if (declaredSize) {
    const width = declaredSize.w;
    const height = declaredSize.h;
    if (width !== imageSize.width || height !== imageSize.height) {
      throw new Error(
        `Atlas metadata declares ${String(width)}x${String(height)}, ` +
          `but the PNG is ${imageSize.width}x${imageSize.height}`,
      );
    }
  }
}

export function readPngSize(bytes: Uint8Array): ImageSize {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("Actor atlas image is not a valid PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = String.fromCharCode(
    bytes[12] ?? 0,
    bytes[13] ?? 0,
    bytes[14] ?? 0,
    bytes[15] ?? 0,
  );
  if (chunkType !== "IHDR") throw new Error("PNG is missing its IHDR header");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseFrameRectangle(input: unknown, frameName: string): FrameRectangle {
  const rectangle = requireRecord(input, `atlas.frames.${frameName}.frame`);
  const result = { x: rectangle.x, y: rectangle.y, w: rectangle.w, h: rectangle.h };
  for (const [field, value] of Object.entries(result)) {
    const invalid =
      !Number.isInteger(value) ||
      (field === "w" || field === "h" ? Number(value) <= 0 : Number(value) < 0);
    if (invalid) throw new Error(`Invalid atlas rectangle ${frameName}.${field}: ${String(value)}`);
  }
  return result as FrameRectangle;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
