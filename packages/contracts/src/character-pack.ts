import { z } from "zod";

import { directionSchema } from "./common";

const directionsSchema = z.object({
  down: z.array(z.string().min(1)).min(1),
  left: z.array(z.string().min(1)).min(1),
  right: z.array(z.string().min(1)).min(1),
  up: z.array(z.string().min(1)).min(1),
});

const optionalDirectionsSchema = z.object({
  down: z.array(z.string().min(1)).min(1).optional(),
  left: z.array(z.string().min(1)).min(1).optional(),
  right: z.array(z.string().min(1)).min(1).optional(),
  up: z.array(z.string().min(1)).min(1).optional(),
});

const animationSchema = z.object({
  fps: z.number().positive().max(60),
  loop: z.boolean(),
  directions: optionalDirectionsSchema,
  fallback: z.enum(["stand", "walk", "idle"]).nullable().optional(),
});

export const characterPackSchema = z
  .object({
    schema_version: z.literal(1),
    actor_id: z.string().regex(/^[a-z0-9_-]+$/),
    display_name: z.string().min(1),
    outfit_id: z.string().min(1),
    atlas: z.object({
      image: z.string().min(1),
      data: z.string().min(1),
    }),
    render: z.object({
      frame_width: z.number().int().positive(),
      frame_height: z.number().int().positive(),
      anchor_x: z.number().nonnegative(),
      anchor_y: z.number().nonnegative(),
      scale: z.number().positive(),
    }),
    physics: z
      .object({
        footprint_width: z.number().positive(),
        footprint_height: z.number().positive(),
        offset_y: z.number().finite().default(0),
      })
      .optional(),
    movement: z.object({
      speed_px_per_second: z.number().positive(),
      idle_after_ms: z.number().int().nonnegative(),
    }),
    default_direction: directionSchema,
    animations: z.object({
      stand: animationSchema.extend({
        directions: directionsSchema,
        fallback: z.null().optional(),
      }),
      walk: animationSchema,
      idle: animationSchema,
    }),
  })
  .superRefine((pack, context) => {
    for (const [state, animation] of Object.entries(pack.animations)) {
      const hasFrames = Object.keys(animation.directions).length > 0;
      if (!hasFrames && !animation.fallback) {
        context.addIssue({
          code: "custom",
          path: ["animations", state],
          message: "animation requires frames or an explicit fallback",
        });
      }
    }
  });

export type CharacterPack = z.infer<typeof characterPackSchema>;

const base20Counts = {
  stand: 1,
  walk: 2,
  idle: 2,
} as const;

/**
 * The canonical ChibiWeaver runtime profile: 4 stand + 8 walk + 8 idle frames.
 * Controller avatars and legacy bundles may continue to use CharacterPack fallbacks,
 * but production character entries marked `base20` must pass this stricter contract.
 */
export const base20CharacterPackSchema = characterPackSchema.superRefine((pack, context) => {
  const references: string[] = [];

  for (const state of ["stand", "walk", "idle"] as const) {
    const animation = pack.animations[state];
    if (animation.fallback) {
      context.addIssue({
        code: "custom",
        path: ["animations", state, "fallback"],
        message: "base20 animations cannot use a fallback",
      });
    }

    for (const direction of directionSchema.options) {
      const frames = animation.directions[direction];
      if (frames?.length !== base20Counts[state]) {
        context.addIssue({
          code: "custom",
          path: ["animations", state, "directions", direction],
          message: `base20 ${state}/${direction} requires exactly ${base20Counts[state]} frame(s)`,
        });
      }
      references.push(...(frames ?? []));
    }
  }

  if (references.length === 20 && new Set(references).size !== 20) {
    context.addIssue({
      code: "custom",
      path: ["animations"],
      message: "base20 requires 20 unique frame references",
    });
  }
});

export type Base20CharacterPack = z.infer<typeof base20CharacterPackSchema>;
