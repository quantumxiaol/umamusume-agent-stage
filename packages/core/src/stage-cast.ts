import {
  stageDefinitionSchema,
  type CharacterAgentMappingEntry,
  type StageDefinition,
} from "@uma-stage/contracts";

export type StageCastOutfit = "uniform" | "race_outfit";

export interface StageCastMember {
  mapping: CharacterAgentMappingEntry;
  outfit: StageCastOutfit;
}

/**
 * Replaces the agent-controlled actor placeholders in a StageDefinition with a
 * concrete cast. The base stage owns spawn intent and control policy; the cast
 * only selects stable actor identities and their visual bundles.
 */
export function applyStageCast(
  stage: StageDefinition,
  cast: StageCastMember[],
): StageDefinition {
  if (cast.length === 0) throw new Error("A stage cast must contain at least one actor");

  const template = stage.actors.find(
    (actor) => !actor.player && actor.control_owner === "agent",
  );
  if (!template) throw new Error(`Stage ${stage.stage_id} has no agent actor template`);

  const characterIds = new Set<string>();
  const stageActorIds = new Set<string>();
  const castActors = cast.map(({ mapping, outfit }) => {
    if (characterIds.has(mapping.character_id)) {
      throw new Error(`Duplicate cast character: ${mapping.character_id}`);
    }
    if (stageActorIds.has(mapping.stage_actor_id)) {
      throw new Error(`Duplicate cast actor: ${mapping.stage_actor_id}`);
    }
    characterIds.add(mapping.character_id);
    stageActorIds.add(mapping.stage_actor_id);
    return {
      ...template,
      instance_id: mapping.stage_actor_id,
      bundle_id:
        outfit === "uniform"
          ? mapping.uniform_bundle_id
          : mapping.race_outfit_bundle_id,
      player: false,
    };
  });

  return stageDefinitionSchema.parse({
    ...stage,
    actors: [
      ...stage.actors.filter(
        (actor) => actor.player || actor.control_owner !== "agent",
      ),
      ...castActors,
    ],
  });
}
