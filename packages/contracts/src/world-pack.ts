import { z } from "zod";

export const worldPackSchema = z.object({
  schema_version: z.literal("world_pack.v1"),
  world_id: z.string().regex(/^[a-z0-9_-]+$/),
  display_name: z.string().min(1),
  description: z.string().default(""),
  reference_image: z.string().optional(),
  locations: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().min(1),
      type: z.string().default(""),
      description: z.string().default(""),
      tags: z.array(z.string()).default([]),
      scene_id: z.string().optional(),
      status: z.enum(["playable", "planned"]).default("planned"),
      map_position: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
  ),
  connections: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        kind: z.enum(["walk", "portal", "door", "transit"]).default("walk"),
      }),
    )
    .default([]),
});

export type WorldPack = z.infer<typeof worldPackSchema>;
