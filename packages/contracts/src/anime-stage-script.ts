import { z } from "zod";

import { directionSchema } from "./common";
import { performanceCueSchema } from "./performance-script";
import { stageEnvironmentSchema } from "./stage-environment";

const performanceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const characterIdSchema = z.string().regex(/^[a-z0-9_]+$/);
const relativeAssetPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "asset path must be relative and cannot escape its content root",
  });

export const animeScriptCharacterSchema = z
  .object({
    speakerId: z.string().min(1),
    slot: z.string().min(1).optional(),
    spriteScale: z.number().positive().optional(),
    spriteVariant: z.string().min(1).optional(),
    sprite: relativeAssetPathSchema.optional(),
  })
  .passthrough();

export const animeScriptLineSchema = z
  .object({
    id: performanceIdSchema,
    type: z.enum(["dialogue", "narration"]),
    speakerId: z.string().min(1),
    speakerLabel: z.string().min(1).optional(),
    showSpeaker: z.boolean().optional(),
    background: z.string().min(1),
    characters: z.array(animeScriptCharacterSchema).default([]),
    audio: relativeAssetPathSchema.optional(),
    spokenText: z.string().min(1),
    subtitleJa: z.string().min(1).optional(),
    subtitleZh: z.string().min(1).optional(),
  })
  .passthrough();

const animeStageCastMemberSchema = z.object({
  anime_speaker_id: z.string().min(1),
  role_id: performanceIdSchema,
  character_id: characterIdSchema,
  display_name: z.string().min(1).optional(),
  outfit_id: z.string().regex(/^[a-z0-9_-]+$/).default("uniform"),
});

const animeStagePlacementSchema = z.object({
  role_id: performanceIdSchema,
  spawn_id: z.string().min(1).optional(),
  facing: directionSchema.optional(),
});

const animeStageSceneSchema = z.object({
  scene_id: performanceIdSchema,
  stage_id: performanceIdSchema,
  backgrounds: z.array(z.string().min(1)).min(1),
  placements: z.array(animeStagePlacementSchema).default([]),
  environment: stageEnvironmentSchema.optional(),
});

const animeStageLineDirectionSchema = z.object({
  before: z.array(performanceCueSchema).default([]),
  during: z.array(performanceCueSchema).default([]),
  after: z.array(performanceCueSchema).default([]),
  duration_ms: z.number().int().positive().optional(),
});

export const animeStageScriptSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().min(1),
    source: z.string().min(1).optional(),
    lines: z.array(animeScriptLineSchema).min(1),
    stage: z.object({
      schema_version: z.literal("anime_stage.v1"),
      performance_id: performanceIdSchema,
      description: z.string().default(""),
      line_gap_ms: z.number().int().nonnegative().default(150),
      cast: z.array(animeStageCastMemberSchema).min(1),
      scenes: z.array(animeStageSceneSchema).min(1),
      directions: z
        .record(z.string().min(1), animeStageLineDirectionSchema)
        .default({}),
    }),
  })
  .passthrough()
  .superRefine((script, context) => {
    const lineIds = new Set<string>();
    script.lines.forEach((line, lineIndex) => {
      if (lineIds.has(line.id)) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "id"],
          message: `duplicate anime line id: ${line.id}`,
        });
      }
      lineIds.add(line.id);
    });

    const roleIds = new Set<string>();
    const speakerIds = new Set<string>();
    script.stage.cast.forEach((member, castIndex) => {
      if (roleIds.has(member.role_id)) {
        context.addIssue({
          code: "custom",
          path: ["stage", "cast", castIndex, "role_id"],
          message: `duplicate Stage role_id: ${member.role_id}`,
        });
      }
      if (speakerIds.has(member.anime_speaker_id)) {
        context.addIssue({
          code: "custom",
          path: ["stage", "cast", castIndex, "anime_speaker_id"],
          message: `duplicate anime speaker mapping: ${member.anime_speaker_id}`,
        });
      }
      roleIds.add(member.role_id);
      speakerIds.add(member.anime_speaker_id);
    });

    const backgrounds = new Set<string>();
    const sceneIds = new Set<string>();
    script.stage.scenes.forEach((scene, sceneIndex) => {
      if (sceneIds.has(scene.scene_id)) {
        context.addIssue({
          code: "custom",
          path: ["stage", "scenes", sceneIndex, "scene_id"],
          message: `duplicate Stage scene_id: ${scene.scene_id}`,
        });
      }
      sceneIds.add(scene.scene_id);
      scene.backgrounds.forEach((background, backgroundIndex) => {
        if (backgrounds.has(background)) {
          context.addIssue({
            code: "custom",
            path: ["stage", "scenes", sceneIndex, "backgrounds", backgroundIndex],
            message: `anime background is mapped more than once: ${background}`,
          });
        }
        backgrounds.add(background);
      });
      scene.placements.forEach((placement, placementIndex) => {
        if (!roleIds.has(placement.role_id)) {
          context.addIssue({
            code: "custom",
            path: ["stage", "scenes", sceneIndex, "placements", placementIndex, "role_id"],
            message: `unknown Stage role_id: ${placement.role_id}`,
          });
        }
      });
    });

    script.lines.forEach((line, lineIndex) => {
      if (!backgrounds.has(line.background)) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "background"],
          message: `anime background has no Stage scene mapping: ${line.background}`,
        });
      }
      if (line.type === "dialogue" && !speakerIds.has(line.speakerId)) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "speakerId"],
          message: `dialogue speaker has no Stage cast mapping: ${line.speakerId}`,
        });
      }
    });

    for (const lineId of Object.keys(script.stage.directions)) {
      if (!lineIds.has(lineId)) {
        context.addIssue({
          code: "custom",
          path: ["stage", "directions", lineId],
          message: `Stage direction references unknown anime line: ${lineId}`,
        });
      }
    }
  });

export type AnimeScriptLine = z.infer<typeof animeScriptLineSchema>;
export type AnimeStageScript = z.infer<typeof animeStageScriptSchema>;
