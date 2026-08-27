import { z } from "zod";

import {
  actorRelativeSideSchema,
  controlOwnerSchema,
  directionSchema,
  tilePositionSchema,
} from "./common";

export const agentCharacterListSchema = z.object({
  characters: z.array(z.string().min(1)),
});

export const agentStageActorBindingSchema = z.object({
  agent_actor_id: z.string().min(1),
  stage_actor_id: z.string().min(1),
});

export const agentLiveStageSchema = z.object({
  schema_version: z.literal("live_stage.v1"),
  stage_id: z.string().min(1),
  scene_id: z.string().min(1),
  actors: z.array(
    z.object({
      actor_id: z.string().min(1),
      tile: tilePositionSchema,
      facing: directionSchema,
      locomotion: z.enum(["stand", "walk", "idle"]),
      control_owner: controlOwnerSchema,
      following_actor_id: z.string().nullable().default(null),
      follow_distance_tiles: z.number().int().min(1).max(4).nullable().default(null),
      nearby_anchors: z.array(z.string()),
    }),
  ),
  anchors: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string().default(""),
      description: z.string().default(""),
      tags: z.array(z.string()).default([]),
      available_slots: z.array(z.string()),
    }),
  ),
  activity_paths: z.array(
    z.object({
      id: z.string().min(1),
      activity_id: z.string().min(1),
      loop: z.boolean(),
    }),
  ),
  portals: z.array(
    z.object({
      id: z.string().min(1),
      target_scene_id: z.string().min(1),
      target_spawn_id: z.string().min(1),
    }),
  ),
});

export const agentStageActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("actor.move_to"),
    actor_id: z.string().min(1),
    anchor_id: z.string().min(1),
    slot_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("actor.face"),
    actor_id: z.string().min(1),
    facing: directionSchema,
  }),
  z.object({
    type: z.literal("actor.face_actor"),
    actor_id: z.string().min(1),
    target_actor_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("actor.approach"),
    actor_id: z.string().min(1),
    target_actor_id: z.string().min(1),
    distance_tiles: z.number().int().min(1).max(4).default(1),
    preferred_side: actorRelativeSideSchema.default("above"),
  }),
  z.object({
    type: z.literal("actor.follow"),
    actor_id: z.string().min(1),
    target_actor_id: z.string().min(1),
    distance_tiles: z.number().int().min(1).max(4).default(2),
    preferred_side: actorRelativeSideSchema.default("above"),
  }),
  z.object({
    type: z.literal("actor.stop_follow"),
    actor_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("actor.travel_to_scene"),
    actor_id: z.string().min(1),
    target_scene_id: z.string().min(1),
    target_spawn_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("actor.stop"),
    actor_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("dialogue.say"),
    actor_id: z.string().min(1),
    text: z.string().min(1),
  }),
]);

export const agentStageSessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    user_uuid: z.string().min(1),
    participants: z.array(
      z.object({
        actor: z
          .object({
            actor_id: z.string().min(1),
            actor_type: z.string().min(1),
            display_name: z.string().min(1),
          })
          .passthrough(),
      }),
    ),
  })
  .passthrough();

export const agentStageEventSchema = z
  .object({
    event_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    event_type: z.string().min(1),
    content: z.string(),
    dialogue: z.string().default(""),
    action: z.string().default(""),
    actor: z
      .object({
        actor_id: z.string().min(1),
        display_name: z.string().min(1),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const agentStageTurnResponseSchema = z.object({
  schema_version: z.literal("agent_stage_turn.v1"),
  session_id: z.string().min(1),
  turn_index: z.number().int().nonnegative(),
  events: z.array(agentStageEventSchema),
  stage_actions: z.array(agentStageActionSchema),
  scene_state: z.record(z.string(), z.unknown()),
});

export type AgentStageActorBinding = z.infer<typeof agentStageActorBindingSchema>;
export type AgentLiveStage = z.infer<typeof agentLiveStageSchema>;
export type AgentStageAction = z.infer<typeof agentStageActionSchema>;
export type AgentStageActionInput = z.input<typeof agentStageActionSchema>;
export type AgentStageEvent = z.infer<typeof agentStageEventSchema>;
export type AgentStageTurnResponse = z.infer<typeof agentStageTurnResponseSchema>;
