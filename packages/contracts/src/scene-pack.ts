import { z } from "zod";

import { directionSchema, tileBoundsSchema, tilePositionSchema } from "./common";

const taggedSchema = z.object({
  tags: z.array(z.string()).default([]),
});

export const sceneAnchorSlotSchema = z.object({
  id: z.string().min(1),
  position: tilePositionSchema,
  facing: directionSchema.optional(),
});

export const sceneAnchorSchema = taggedSchema.extend({
  id: z.string().min(1),
  display_name: z.string().min(1),
  description: z.string().default(""),
  position: tilePositionSchema,
  facing: directionSchema.optional(),
  slots: z.array(sceneAnchorSlotSchema).default([]),
  interactions: z.array(z.string()).default([]),
});

export const sceneTilesetSchema = z.object({
  id: z.string().min(1),
  image: z.string().min(1),
  tile_width: z.number().int().positive(),
  tile_height: z.number().int().positive(),
  columns: z.number().int().positive(),
  tile_count: z.number().int().positive(),
});

export const sceneTileLayerSchema = z.object({
  name: z.string().min(1),
  data: z.array(z.number().int().min(-1)),
});

export const sceneLandmarkSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  kind: z.string().min(1),
  bounds: tileBoundsSchema,
  render_mode: z.string().optional(),
});

export const scenePackSchema = z
  .object({
    schema_version: z.literal("scene_pack.v1"),
    scene_id: z.string().regex(/^[a-z0-9_-]+$/),
    display_name: z.string().min(1),
    description: z.string().default(""),
    source: z
      .object({
        format: z.string().min(1),
        path: z.string().min(1),
      })
      .optional(),
    map: z.object({
      tile_size: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#6f9f75"),
      tiled_source: z.string().optional(),
    }),
    tileset: sceneTilesetSchema.optional(),
    layers: z.array(sceneTileLayerSchema).default([]),
    landmarks: z.array(sceneLandmarkSchema).default([]),
    navigation: z.object({
      blocked_tiles: z.array(tilePositionSchema).default([]),
    }),
    zones: z
    .array(
      taggedSchema.extend({
        id: z.string().min(1),
        display_name: z.string().min(1),
        type: z.string().default(""),
        description: z.string().default(""),
        bounds: tileBoundsSchema,
      }),
    )
      .default([]),
    surfaces: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["grass", "path", "plaza", "track", "water", "floor"]),
        bounds: tileBoundsSchema,
      }),
    )
      .default([]),
    props: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["building", "tree", "bench", "fountain", "vending_machine", "sign"]),
        bounds: tileBoundsSchema,
        label: z.string().optional(),
        y_sort: z.boolean().default(false),
      }),
    )
      .default([]),
    anchors: z.array(sceneAnchorSchema).default([]),
    spawns: z
    .array(
      z.object({
        id: z.string().min(1),
        position: tilePositionSchema,
        facing: directionSchema.default("down"),
      }),
    )
      .default([]),
    portals: z
    .array(
      z.object({
        id: z.string().min(1),
        position: tilePositionSchema,
        target_scene_id: z.string().min(1),
        target_spawn_id: z.string().min(1),
      }),
    )
      .default([]),
    activity_paths: z
    .array(
      z.object({
        id: z.string().min(1),
        activity_id: z.string().min(1),
        anchor_id: z.string().optional(),
        loop: z.boolean().default(false),
        points: z.array(tilePositionSchema).min(1),
      }),
    )
      .default([]),
  })
  .superRefine((scene, context) => {
    const cellCount = scene.map.width * scene.map.height;
    scene.layers.forEach((layer, index) => {
      if (layer.data.length !== cellCount) {
        context.addIssue({
          code: "custom",
          path: ["layers", index, "data"],
          message: `tile layer must contain ${cellCount} cells, got ${layer.data.length}`,
        });
      }
    });
    if (scene.layers.length > 0 && !scene.tileset) {
      context.addIssue({
        code: "custom",
        path: ["tileset"],
        message: "tileset is required when tile layers are present",
      });
    }
  });

export type ScenePack = z.infer<typeof scenePackSchema>;
export type SceneAnchor = z.infer<typeof sceneAnchorSchema>;
