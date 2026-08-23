import { z } from "zod";

const contentPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "content path must be relative and cannot escape the content root",
  });

export const characterRegistryEntrySchema = z.object({
  bundle_id: z.string().regex(/^[a-z0-9_-]+$/),
  actor_path: contentPathSchema.refine((path) => path.endsWith("/actor.json"), {
    message: "actor_path must point to actor.json",
  }),
  role: z.enum(["character", "controller_avatar"]),
  animation_profile: z.enum(["base20", "fallback"]),
});

export const characterRegistrySchema = z
  .object({
    schema_version: z.literal("character_registry.v1"),
    characters: z.array(characterRegistryEntrySchema).min(1),
  })
  .superRefine((registry, context) => {
    addDuplicateIssues(
      registry.characters.map((entry) => entry.bundle_id),
      ["characters"],
      "bundle_id",
      context,
    );
    addDuplicateIssues(
      registry.characters.map((entry) => entry.actor_path),
      ["characters"],
      "actor_path",
      context,
    );
  });

function addDuplicateIssues(
  values: string[],
  path: PropertyKey[],
  field: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index, field],
        message: `duplicate ${field}: ${value}`,
      });
    }
    seen.add(value);
  });
}

export type CharacterRegistryEntry = z.infer<typeof characterRegistryEntrySchema>;
export type CharacterRegistry = z.infer<typeof characterRegistrySchema>;
