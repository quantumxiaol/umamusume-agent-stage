import { z } from "zod";

import { actorRelativeSideSchema, commandPolicySchema, directionSchema } from "./common";

const performanceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const relativeAssetPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "asset path must be relative and cannot escape its content root",
  });

const cueBaseSchema = z.object({ cue_id: performanceIdSchema });
const actorCueBaseSchema = cueBaseSchema.extend({ role_id: performanceIdSchema });

export const performanceCueSchema = z.discriminatedUnion("type", [
  actorCueBaseSchema.extend({
    type: z.literal("actor.move_to"),
    target: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("anchor"),
        anchor_id: z.string().min(1),
        slot_id: z.string().min(1).optional(),
      }),
      z.object({
        type: z.literal("actor"),
        role_id: performanceIdSchema,
        distance_tiles: z.number().int().min(1).max(4).default(1),
        preferred_side: actorRelativeSideSchema.default("above"),
      }),
    ]),
    policy: commandPolicySchema.default("replace"),
  }),
  actorCueBaseSchema.extend({
    type: z.literal("actor.follow_activity_path"),
    activity_path_id: z.string().min(1),
    cycles: z.number().int().positive().max(10).default(1),
    policy: commandPolicySchema.default("replace"),
  }),
  actorCueBaseSchema.extend({
    type: z.literal("actor.follow"),
    target_role_id: performanceIdSchema,
    distance_tiles: z.number().int().min(1).max(4).default(2),
    preferred_side: actorRelativeSideSchema.default("above"),
  }),
  actorCueBaseSchema.extend({ type: z.literal("actor.stop_follow") }),
  actorCueBaseSchema.extend({
    type: z.literal("actor.face"),
    facing: directionSchema,
  }),
  actorCueBaseSchema.extend({
    type: z.literal("actor.face_actor"),
    target_role_id: performanceIdSchema,
  }),
  actorCueBaseSchema.extend({ type: z.literal("actor.stop") }),
  actorCueBaseSchema.extend({
    type: z.literal("dialogue.say"),
    text: z.string().min(1),
    spoken_text: z.string().min(1).optional(),
    subtitle_ja: z.string().min(1).optional(),
    subtitle_zh: z.string().min(1).optional(),
    audio_path: relativeAssetPathSchema.optional(),
    duration_ms: z.number().int().positive().optional(),
  }),
  cueBaseSchema.extend({
    type: z.literal("narration.say"),
    text: z.string().min(1),
    subtitle_ja: z.string().min(1).optional(),
    subtitle_zh: z.string().min(1).optional(),
    audio_path: relativeAssetPathSchema.optional(),
    duration_ms: z.number().int().positive().optional(),
  }),
  cueBaseSchema.extend({
    type: z.literal("stage.wait"),
    duration_ms: z.number().int().nonnegative(),
  }),
  cueBaseSchema.extend({
    type: z.literal("camera.follow_actor"),
    role_id: performanceIdSchema,
    zoom: z.number().positive().max(4).default(0.8),
  }),
  cueBaseSchema.extend({
    type: z.literal("camera.focus_actor"),
    role_id: performanceIdSchema,
    zoom: z.number().positive().max(4).default(0.8),
  }),
  cueBaseSchema.extend({
    type: z.literal("camera.focus_anchor"),
    anchor_id: z.string().min(1),
    zoom: z.number().positive().max(4).default(0.8),
  }),
  cueBaseSchema.extend({
    type: z.literal("camera.focus_zone"),
    zone_id: z.string().min(1),
    zoom: z.number().positive().max(4).default(0.8),
  }),
  cueBaseSchema.extend({
    type: z.literal("camera.fixed"),
    center: z.object({ x: z.number(), y: z.number() }),
    zoom: z.number().positive().max(4).default(0.8),
  }),
  cueBaseSchema.extend({ type: z.literal("camera.overview") }),
]);

export const performanceBeatSchema = z.object({
  beat_id: performanceIdSchema,
  cues: z.array(performanceCueSchema).min(1),
  wait_for: z.enum(["all", "none"]).default("all"),
  hold_ms: z.number().int().nonnegative().default(0),
});

export const performanceScriptSchema = z
  .object({
    schema_version: z.literal("performance_script.v1"),
    performance_id: performanceIdSchema,
    title: z.string().min(1),
    description: z.string().default(""),
    cast: z
      .array(
        z.object({
          role_id: performanceIdSchema,
          character_id: z.string().regex(/^[a-z0-9_]+$/),
          display_name: z.string().min(1).optional(),
          outfit_id: z.string().regex(/^[a-z0-9_-]+$/).default("uniform"),
          render_hints: z
            .object({
              anime_sprite: relativeAssetPathSchema.optional(),
              anime_scale: z.number().positive().optional(),
            })
            .optional(),
        }),
      )
      .min(1),
    scenes: z
      .array(
        z.object({
          scene_id: performanceIdSchema,
          stage_id: performanceIdSchema,
          placements: z
            .array(
              z.object({
                role_id: performanceIdSchema,
                spawn_id: z.string().min(1).optional(),
                facing: directionSchema.optional(),
                anime_slot: z.string().min(1).optional(),
              }),
            )
            .default([]),
          render_hints: z
            .object({ anime_background: z.string().min(1).optional() })
            .optional(),
          beats: z.array(performanceBeatSchema).min(1),
        }),
      )
      .min(1),
  })
  .superRefine((script, context) => {
    const roleIds = uniqueField(
      script.cast,
      (member) => member.role_id,
      ["cast"],
      "role_id",
      context,
    );
    uniqueField(
      script.cast,
      (member) => member.character_id,
      ["cast"],
      "character_id",
      context,
    );
    uniqueField(
      script.scenes,
      (scene) => scene.scene_id,
      ["scenes"],
      "scene_id",
      context,
    );
    const beatIds = new Set<string>();
    const cueIds = new Set<string>();

    script.scenes.forEach((scene, sceneIndex) => {
      const placedRoles = new Set<string>();
      scene.placements.forEach((placement, placementIndex) => {
        validateRole(
          placement.role_id,
          roleIds,
          ["scenes", sceneIndex, "placements", placementIndex, "role_id"],
          context,
        );
        if (placedRoles.has(placement.role_id)) {
          context.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "placements", placementIndex, "role_id"],
            message: `duplicate scene placement: ${placement.role_id}`,
          });
        }
        placedRoles.add(placement.role_id);
      });

      scene.beats.forEach((beat, beatIndex) => {
        if (beatIds.has(beat.beat_id)) {
          context.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "beats", beatIndex, "beat_id"],
            message: `duplicate beat_id: ${beat.beat_id}`,
          });
        }
        beatIds.add(beat.beat_id);

        beat.cues.forEach((cue, cueIndex) => {
          const cuePath = ["scenes", sceneIndex, "beats", beatIndex, "cues", cueIndex];
          if (cueIds.has(cue.cue_id)) {
            context.addIssue({
              code: "custom",
              path: [...cuePath, "cue_id"],
              message: `duplicate cue_id: ${cue.cue_id}`,
            });
          }
          cueIds.add(cue.cue_id);
          for (const roleId of cueRoleIds(cue)) {
            validateRole(roleId, roleIds, [...cuePath, "role_id"], context);
          }
        });
      });
    });
  });

export type PerformanceCue = z.infer<typeof performanceCueSchema>;
export type PerformanceBeat = z.infer<typeof performanceBeatSchema>;
export type PerformanceScript = z.infer<typeof performanceScriptSchema>;

function cueRoleIds(cue: PerformanceCue): string[] {
  if (cue.type === "actor.move_to") {
    return [cue.role_id, ...(cue.target.type === "actor" ? [cue.target.role_id] : [])];
  }
  if (cue.type === "actor.follow" || cue.type === "actor.face_actor") {
    return [cue.role_id, cue.target_role_id];
  }
  if (
    cue.type === "actor.follow_activity_path" ||
    cue.type === "actor.stop_follow" ||
    cue.type === "actor.face" ||
    cue.type === "actor.stop" ||
    cue.type === "dialogue.say" ||
    cue.type === "camera.follow_actor" ||
    cue.type === "camera.focus_actor"
  ) return [cue.role_id];
  return [];
}

function uniqueField<T>(
  values: T[],
  valueOf: (value: T) => string,
  basePath: Array<string | number>,
  field: string,
  context: z.RefinementCtx,
): Set<string> {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const item = valueOf(value);
    if (seen.has(item)) {
      context.addIssue({
        code: "custom",
        path: [...basePath, index, field],
        message: `duplicate ${field}: ${item}`,
      });
    }
    seen.add(item);
  });
  return seen;
}

function validateRole(
  roleId: string,
  knownRoles: Set<string>,
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (knownRoles.has(roleId)) return;
  context.addIssue({ code: "custom", path, message: `unknown role_id: ${roleId}` });
}
