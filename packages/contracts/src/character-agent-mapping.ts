import { z } from "zod";

export const characterAgentMappingEntrySchema = z.object({
  character_id: z.string().regex(/^[a-z0-9_]+$/),
  agent_character_name: z.string().min(1),
  stage_actor_id: z.string().regex(/^uma_[a-z0-9_]+$/),
  uniform_bundle_id: z.string().regex(/^[a-z0-9_-]+$/),
  race_outfit_bundle_id: z.string().regex(/^[a-z0-9_-]+$/),
});

export const characterAgentMappingSchema = z
  .object({
    schema_version: z.literal("character_agent_mapping.v1"),
    characters: z.array(characterAgentMappingEntrySchema).min(1),
  })
  .superRefine((mapping, context) => {
    const uniqueFields = [
      "character_id",
      "agent_character_name",
      "stage_actor_id",
      "uniform_bundle_id",
      "race_outfit_bundle_id",
    ] as const;

    for (const field of uniqueFields) {
      const seen = new Set<string>();
      mapping.characters.forEach((entry, index) => {
        const value = entry[field];
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: ["characters", index, field],
            message: `duplicate ${field}: ${value}`,
          });
        }
        seen.add(value);
      });
    }

    mapping.characters.forEach((entry, index) => {
      if (entry.stage_actor_id !== `uma_${entry.character_id}`) {
        context.addIssue({
          code: "custom",
          path: ["characters", index, "stage_actor_id"],
          message: "stage_actor_id must be uma_<character_id>",
        });
      }
    });
  });

export type CharacterAgentMappingEntry = z.infer<
  typeof characterAgentMappingEntrySchema
>;
export type CharacterAgentMapping = z.infer<typeof characterAgentMappingSchema>;
