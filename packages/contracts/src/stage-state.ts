import { z } from "zod";

import { controlOwnerSchema, directionSchema, worldPositionSchema } from "./common";

export const actorLocomotionSchema = z.enum(["stand", "walk", "idle"]);
export type ActorLocomotion = z.infer<typeof actorLocomotionSchema>;

export const stageActorStateSchema = z.object({
  actor_id: z.string(),
  character_pack_id: z.string(),
  position: worldPositionSchema,
  facing: directionSchema,
  locomotion: actorLocomotionSchema,
  control_owner: controlOwnerSchema,
  speech: z.string().nullable(),
  active_locomotion_task_id: z.string().nullable(),
  following_actor_id: z.string().nullable(),
  follow_distance_tiles: z.number().int().min(1).max(4).nullable(),
});
export type StageActorState = z.infer<typeof stageActorStateSchema>;

export const stageEventTypeSchema = z.enum([
  "actor.spawned",
  "actor.despawned",
  "actor.movement_started",
  "actor.arrived",
  "actor.facing_changed",
  "actor.follow_started",
  "actor.follow_stopped",
  "portal.entered",
  "dialogue.started",
  "dialogue.completed",
  "command.accepted",
  "command.started",
  "command.completed",
  "command.failed",
  "command.cancelled",
  "control.changed",
]);

export const stageEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  time_ms: z.number().nonnegative(),
  type: stageEventTypeSchema,
  actor_id: z.string().optional(),
  command_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type StageEvent = z.infer<typeof stageEventSchema>;

export interface StageSnapshot {
  scene_id: string;
  time_ms: number;
  actors: StageActorState[];
}
