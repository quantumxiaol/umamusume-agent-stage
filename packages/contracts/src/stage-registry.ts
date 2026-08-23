import { z } from "zod";

const definitionPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.split("/").includes("..") &&
      path.endsWith(".stage.json"),
    { message: "definition path must be a relative .stage.json content path" },
  );

export const stageRegistryEntrySchema = z.object({
  stage_id: z.string().regex(/^[a-z0-9_-]+$/),
  scene_id: z.string().regex(/^[a-z0-9_-]+$/),
  display_name: z.string().min(1),
  definition_path: definitionPathSchema,
});

export const stageRegistrySchema = z
  .object({
    schema_version: z.literal("stage_registry.v1"),
    default_definition_path: definitionPathSchema,
    stages: z.array(stageRegistryEntrySchema).min(1),
  })
  .superRefine((registry, context) => {
    for (const field of ["stage_id", "scene_id", "definition_path"] as const) {
      const seen = new Set<string>();
      registry.stages.forEach((entry, index) => {
        if (seen.has(entry[field])) {
          context.addIssue({
            code: "custom",
            path: ["stages", index, field],
            message: `duplicate ${field}: ${entry[field]}`,
          });
        }
        seen.add(entry[field]);
      });
    }
    if (!registry.stages.some((entry) => entry.definition_path === registry.default_definition_path)) {
      context.addIssue({
        code: "custom",
        path: ["default_definition_path"],
        message: "default stage must be registered",
      });
    }
  });

export type StageRegistryEntry = z.infer<typeof stageRegistryEntrySchema>;
export type StageRegistry = z.infer<typeof stageRegistrySchema>;
