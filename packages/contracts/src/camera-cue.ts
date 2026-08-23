import { z } from "zod";

const cameraZoomSchema = z.number().positive().max(4).default(0.8);

export const cameraCueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("camera.follow_actor"),
    actor_id: z.string().min(1),
    zoom: cameraZoomSchema,
  }),
  z.object({
    type: z.literal("camera.focus_actor"),
    actor_id: z.string().min(1),
    zoom: cameraZoomSchema,
  }),
  z.object({
    type: z.literal("camera.focus_anchor"),
    anchor_id: z.string().min(1),
    zoom: cameraZoomSchema,
  }),
  z.object({
    type: z.literal("camera.focus_zone"),
    zone_id: z.string().min(1),
    zoom: cameraZoomSchema,
  }),
  z.object({
    type: z.literal("camera.fixed"),
    center: z.object({ x: z.number(), y: z.number() }),
    zoom: cameraZoomSchema,
  }),
  z.object({
    type: z.literal("camera.overview"),
  }),
]);

export type CameraCue = z.infer<typeof cameraCueSchema>;
