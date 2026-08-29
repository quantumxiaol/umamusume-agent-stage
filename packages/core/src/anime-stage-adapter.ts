import {
  performanceScriptSchema,
  type AnimeScriptLine,
  type AnimeStageScript,
  type PerformanceCue,
  type PerformanceScript,
} from "@uma-stage/contracts";

interface PerformanceSceneDraft {
  scene_id: string;
  stage_id: string;
  placements: AnimeStageScript["stage"]["scenes"][number]["placements"];
  environment?: AnimeStageScript["stage"]["scenes"][number]["environment"];
  beats: Array<{
    beat_id: string;
    cues: PerformanceCue[] | Array<Record<string, unknown>>;
    wait_for: "all";
    hold_ms: number;
  }>;
}

export function compileAnimeStageScript(script: AnimeStageScript): PerformanceScript {
  const castBySpeakerId = new Map(
    script.stage.cast.map((member) => [member.anime_speaker_id, member]),
  );
  const sceneByBackground = new Map(
    script.stage.scenes.flatMap((scene) =>
      scene.backgrounds.map((background) => [background, scene] as const),
    ),
  );
  const sceneOccurrences = new Map<string, number>();
  const allocatedSceneIds = new Set<string>();
  const scenes: PerformanceSceneDraft[] = [];
  let activeSceneSource: AnimeStageScript["stage"]["scenes"][number] | null = null;
  let activeScene: PerformanceSceneDraft | null = null;

  for (const line of script.lines) {
    const sourceScene = sceneByBackground.get(line.background);
    if (!sourceScene) {
      throw new Error(`Anime background has no Stage scene mapping: ${line.background}`);
    }
    if (sourceScene !== activeSceneSource || !activeScene) {
      activeSceneSource = sourceScene;
      activeScene = {
        scene_id: allocateSceneId(
          sourceScene.scene_id,
          sceneOccurrences,
          allocatedSceneIds,
        ),
        stage_id: sourceScene.stage_id,
        placements: sourceScene.placements,
        ...(sourceScene.environment ? { environment: sourceScene.environment } : {}),
        beats: [],
      };
      scenes.push(activeScene);
    }
    activeScene.beats.push(...compileAnimeLine(line, script, castBySpeakerId));
  }

  return performanceScriptSchema.parse({
    schema_version: "performance_script.v1",
    performance_id: script.stage.performance_id,
    title: script.title,
    description: script.stage.description || script.source || "",
    cast: script.stage.cast.map((member) => ({
      role_id: member.role_id,
      character_id: member.character_id,
      ...(member.display_name ? { display_name: member.display_name } : {}),
      outfit_id: member.outfit_id,
    })),
    scenes,
  });
}

function compileAnimeLine(
  line: AnimeScriptLine,
  script: AnimeStageScript,
  castBySpeakerId: ReadonlyMap<string, AnimeStageScript["stage"]["cast"][number]>,
): PerformanceSceneDraft["beats"] {
  const direction = script.stage.directions[line.id];
  const beats: PerformanceSceneDraft["beats"] = [];
  if (direction?.before.length) {
    beats.push({
      beat_id: `${line.id}_before`,
      cues: direction.before,
      wait_for: "all",
      hold_ms: 0,
    });
  }

  const lineCue = lineToPerformanceCue(line, direction?.duration_ms, castBySpeakerId);
  beats.push({
    beat_id: `${line.id}_line`,
    cues: [...(direction?.during ?? []), lineCue],
    wait_for: "all",
    hold_ms: script.stage.line_gap_ms,
  });

  if (direction?.after.length) {
    beats.push({
      beat_id: `${line.id}_after`,
      cues: direction.after,
      wait_for: "all",
      hold_ms: 0,
    });
  }
  return beats;
}

function lineToPerformanceCue(
  line: AnimeScriptLine,
  durationMs: number | undefined,
  castBySpeakerId: ReadonlyMap<string, AnimeStageScript["stage"]["cast"][number]>,
): Record<string, unknown> {
  const shared = {
    cue_id: `${line.id}_speech`,
    text: line.subtitleZh ?? line.subtitleJa ?? line.spokenText,
    ...(line.subtitleJa ? { subtitle_ja: line.subtitleJa } : {}),
    ...(line.subtitleZh ? { subtitle_zh: line.subtitleZh } : {}),
    ...(line.audio ? { audio_path: line.audio } : {}),
    ...(durationMs ? { duration_ms: durationMs } : {}),
  };
  if (line.type === "narration") {
    return { ...shared, type: "narration.say" };
  }
  const member = castBySpeakerId.get(line.speakerId);
  if (!member) throw new Error(`Dialogue speaker has no Stage cast mapping: ${line.speakerId}`);
  return {
    ...shared,
    type: "dialogue.say",
    role_id: member.role_id,
    spoken_text: line.spokenText,
  };
}

function allocateSceneId(
  baseId: string,
  occurrences: Map<string, number>,
  allocated: Set<string>,
): string {
  let occurrence = (occurrences.get(baseId) ?? 0) + 1;
  let candidate = occurrence === 1 ? baseId : `${baseId}_${occurrence}`;
  while (allocated.has(candidate)) {
    occurrence += 1;
    candidate = `${baseId}_${occurrence}`;
  }
  occurrences.set(baseId, occurrence);
  allocated.add(candidate);
  return candidate;
}
