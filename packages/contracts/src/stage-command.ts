import { z } from "zod";

import {
  commandPolicySchema,
  controlOwnerSchema,
  directionSchema,
  tilePositionSchema,
} from "./common";

const baseCommandSchema = z.object({
  id: z.string().min(1),
  actor_id: z.string().min(1),
  source: controlOwnerSchema,
  policy: commandPolicySchema.default("reject"),
});

export const stageCommandSchema = z.discriminatedUnion("type", [
  baseCommandSchema.extend({
    type: z.literal("actor.move_to"),
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("anchor"), id: z.string().min(1), slot_id: z.string().optional() }),
      z.object({ type: z.literal("tile"), position: tilePositionSchema }),
      z.object({
        type: z.literal("actor"),
        id: z.string().min(1),
        distance_tiles: z.number().int().min(1).max(4).default(1),
      }),
    ]),
  }),
  baseCommandSchema.extend({
    type: z.literal("actor.follow_activity_path"),
    activity_path_id: z.string().min(1),
    cycles: z.number().int().positive().max(10).default(1),
  }),
  baseCommandSchema.extend({
    type: z.literal("actor.follow"),
    target_actor_id: z.string().min(1),
    distance_tiles: z.number().int().min(1).max(4).default(2),
  }),
  baseCommandSchema.extend({
    type: z.literal("actor.stop_follow"),
  }),
  baseCommandSchema.extend({
    type: z.literal("actor.face"),
    facing: directionSchema,
  }),
  baseCommandSchema.extend({
    type: z.literal("actor.stop"),
  }),
  baseCommandSchema.extend({
    type: z.literal("dialogue.say"),
    text: z.string().min(1),
    duration_ms: z.number().int().positive().optional(),
  }),
]);

export type StageCommand = z.infer<typeof stageCommandSchema>;
export type MoveToCommand = Extract<StageCommand, { type: "actor.move_to" }>;
export type FollowActivityPathCommand = Extract<
  StageCommand,
  { type: "actor.follow_activity_path" }
>;
export type FollowActorCommand = Extract<StageCommand, { type: "actor.follow" }>;

export const stageTaskStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type StageTaskStatus = z.infer<typeof stageTaskStatusSchema>;
