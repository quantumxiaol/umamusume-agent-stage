import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { agentLiveStageSchema, agentStageActionSchema } from "./agent-stage-api";
import { base20CharacterPackSchema, characterPackSchema } from "./character-pack";
import { cameraCueSchema } from "./camera-cue";
import { characterAgentMappingSchema } from "./character-agent-mapping";
import { characterRegistrySchema } from "./character-registry";
import { performanceScriptSchema } from "./performance-script";
import { scenePackSchema } from "./scene-pack";
import { stageCommandSchema } from "./stage-command";
import { stageDefinitionSchema } from "./stage-definition";
import { stageRegistrySchema } from "./stage-registry";
import { worldPackSchema } from "./world-pack";

const outputDirectory = resolve(import.meta.dirname, "../../../schemas");
await mkdir(outputDirectory, { recursive: true });

const schemas = [
  ["agent-live-stage.v1.json", agentLiveStageSchema],
  ["agent-stage-action.v1.json", agentStageActionSchema],
  ["character-pack.v1.json", characterPackSchema],
  ["character-pack.base20.v1.json", base20CharacterPackSchema],
  ["camera-cue.v1.json", cameraCueSchema],
  ["character-agent-mapping.v1.json", characterAgentMappingSchema],
  ["character-registry.v1.json", characterRegistrySchema],
  ["performance-script.v1.json", performanceScriptSchema],
  ["scene-pack.v1.json", scenePackSchema],
  ["stage-command.v1.json", stageCommandSchema],
  ["stage-definition.v1.json", stageDefinitionSchema],
  ["stage-registry.v1.json", stageRegistrySchema],
  ["world-pack.v1.json", worldPackSchema],
] as const;

for (const [filename, schema] of schemas) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  await writeFile(
    resolve(outputDirectory, filename),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    "utf8",
  );
}

console.log(`Wrote ${schemas.length} schemas to ${outputDirectory}`);
