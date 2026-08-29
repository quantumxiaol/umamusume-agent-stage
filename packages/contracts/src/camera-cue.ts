import { z } from "zod";

const cameraZoomSchema = z.number().positive().max(4).default(0.8);
const cameraTransitionSchema = z.number().int().min(0).max(10_000).default(450);

export const cameraCueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("camera.follow_actor"),
    actor_id: z.string().min(1),
    zoom: cameraZoomSchema,
    transition_ms: cameraTransitionSchema,
  }),
  z.object({
    type: z.literal("camera.focus_actor"),
    actor_id: z.string().min(1),
    zoom: cameraZoomSchema,
    transition_ms: cameraTransitionSchema,
  }),
  z.object({
    type: z.literal("camera.focus_anchor"),
    anchor_id: z.string().min(1),
    zoom: cameraZoomSchema,
    transition_ms: cameraTransitionSchema,
  }),
  z.object({
    type: z.literal("camera.focus_zone"),
    zone_id: z.string().min(1),
    zoom: cameraZoomSchema,
    transition_ms: cameraTransitionSchema,
  }),
  z.object({
    type: z.literal("camera.fixed"),
    center: z.object({ x: z.number(), y: z.number() }),
    zoom: cameraZoomSchema,
    transition_ms: cameraTransitionSchema,
  }),
  z.object({
    type: z.literal("camera.overview"),
    transition_ms: cameraTransitionSchema,
  }),
]);

export type CameraCue = z.infer<typeof cameraCueSchema>;
