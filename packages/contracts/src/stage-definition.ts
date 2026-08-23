import { z } from "zod";

import { controlOwnerSchema } from "./common";

const contentPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "content path must be relative and cannot escape the content root",
  });

export const stageActorDefinitionSchema = z.object({
  instance_id: z.string().regex(/^[a-z0-9_-]+$/),
  bundle_id: z.string().regex(/^[a-z0-9_-]+$/),
  spawn_id: z.string().min(1),
  control_owner: controlOwnerSchema,
  player: z.boolean().default(false),
});

export const stageDefinitionSchema = z
  .object({
    schema_version: z.literal("stage_definition.v1"),
    stage_id: z.string().regex(/^[a-z0-9_-]+$/),
    display_name: z.string().min(1),
    scene_path: contentPathSchema.refine((path) => path.endsWith("/scene.json"), {
      message: "scene_path must point to scene.json",
    }),
    actors: z.array(stageActorDefinitionSchema).min(1),
  })
  .superRefine((stage, context) => {
    const seen = new Set<string>();
    let playerCount = 0;
    stage.actors.forEach((actor, index) => {
      if (seen.has(actor.instance_id)) {
        context.addIssue({
          code: "custom",
          path: ["actors", index, "instance_id"],
          message: `duplicate instance_id: ${actor.instance_id}`,
        });
      }
      seen.add(actor.instance_id);

      if (actor.player) {
        playerCount += 1;
        if (actor.control_owner !== "player") {
          context.addIssue({
            code: "custom",
            path: ["actors", index, "control_owner"],
            message: "the player actor must use player control ownership",
          });
        }
      }
    });

    if (playerCount > 1) {
      context.addIssue({
        code: "custom",
        path: ["actors"],
        message: "a stage can declare at most one player actor",
      });
    }
  });

export type StageActorDefinition = z.infer<typeof stageActorDefinitionSchema>;
export type StageDefinition = z.infer<typeof stageDefinitionSchema>;
