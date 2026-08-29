<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  AgentApiClient,
  AgentApiError,
  reconcileStageTurnActions,
  stageActionToCommand,
} from "@uma-stage/agent-client";
import {
  agentLiveStageSchema,
  animeStageScriptSchema,
  characterAgentMappingSchema,
  characterPackSchema,
  characterRegistrySchema,
  performanceScriptSchema,
  scenePackSchema,
  stageEnvironmentSchema,
  stageDefinitionSchema,
  stageRegistrySchema,
  type CharacterAgentMapping,
  type CharacterAgentMappingEntry,
  type CharacterPack,
  type CharacterRegistry,
  type AgentStageAction,
  type AgentStageEvent,
  type PerformanceCue,
  type PerformanceScript,
  type ScenePack,
  type StageActorState,
  type StageDefinition,
  type StageEnvironment,
  type StageEvent,
  type StageRegistry,
  type StageRegistryEntry,
} from "@uma-stage/contracts";
import {
  applyStageCast,
  assignStageSpawns,
  compileAnimeStageScript,
  compilePerformanceCue,
  ensureSceneSpawnCapacity,
  placeScenePresences,
  StageRuntime,
  WorldPresence,
  type CommandResult,
  type StageCastOutfit,
} from "@uma-stage/core";

import { useStageStore } from "./stores/stage";

type RendererModule = typeof import("@uma-stage/renderer-phaser");
type StageGame = ReturnType<RendererModule["createStageGame"]>;
type AgentStatus = "disconnected" | "connecting" | "connected" | "busy" | "error";

interface CastSelection {
  characterId: string;
  outfit: StageCastOutfit;
}

interface ResolvedCastMember extends CastSelection {
  mapping: CharacterAgentMappingEntry;
}

interface ActorPresentation {
  instanceId: string;
  displayName: string;
  player: boolean;
  initials: string;
}

interface AgentSession {
  sessionId: string;
  userUuid: string;
  castKey: string;
  actors: Array<{
    characterId: string;
    displayName: string;
    agentActorId: string;
    stageActorId: string;
  }>;
}

interface ConversationLine {
  id: string;
  speaker: string;
  text: string;
  kind: "trainer" | "character" | "action" | "command" | "narrator" | "system";
}

interface PendingAgentReply {
  event: AgentStageEvent;
  stageActorId: string | null;
  actionShown: boolean;
  dialogueShown: boolean;
}

interface FollowBinding {
  actorId: string;
  targetActorId: string;
  distanceTiles: number;
}

interface StageInitializationOptions {
  definitionPath?: string;
  spawnOverrides?: Record<string, string>;
  followBindings?: FollowBinding[];
  resetWorld?: boolean;
  skipPresenceSync?: boolean;
}

const environment = import.meta.env as unknown as Record<string, string | undefined>;
const defaultAgentUrl =
  environment.UMAMUSUME_AGENT_URL?.trim() ||
  environment.VITE_UMAMUSUME_AGENT_URL?.trim() ||
  "http://127.0.0.1:1111";
const configuredAgentKey =
  environment.UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() ||
  environment.VITE_UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() ||
  "";

const stageElement = ref<HTMLElement | null>(null);
const store = useStageStore();
const stageName = ref("特雷森学生广场");
const currentStageId = ref("");
const actorViews = ref<ActorPresentation[]>([]);
const stageChoices = ref<StageRegistryEntry[]>([]);
const activeStagePath = ref("");
const currentSceneId = ref("");
const currentPlayerActorId = ref("");
const sceneAnchors = ref<Array<{ id: string; displayName: string }>>([]);
const sceneZones = ref<Array<{ id: string; displayName: string }>>([]);
const activityPaths = ref<Array<{ id: string; activityId: string }>>([]);
const characterMappings = ref<CharacterAgentMappingEntry[]>([]);
const selectedCast = ref<CastSelection[]>([
  { characterId: "admire_vega", outfit: "uniform" },
  { characterId: "almond_eye", outfit: "uniform" },
]);
const activeActorId = ref("uma_admire_vega");

const agentStatus = ref<AgentStatus>("disconnected");
const agentStatusMessage = ref("正在等待舞台初始化…");
const agentCharacters = ref<string[]>([]);
const agentSession = ref<AgentSession | null>(null);
const agentInput = ref("");
const conversation = ref<ConversationLine[]>([]);
const performanceRunning = ref(false);
const stageEnvironment = ref<StageEnvironment>(stageEnvironmentSchema.parse({}));

const resolvedCast = computed<ResolvedCastMember[]>(() =>
  selectedCast.value.flatMap((selection) => {
    const mapping = characterMappings.value.find(
      (entry) => entry.character_id === selection.characterId,
    );
    return mapping ? [{ ...selection, mapping }] : [];
  }),
);
const activeMapping = computed(
  () =>
    resolvedCast.value.find(
      (member) => member.mapping.stage_actor_id === activeActorId.value,
    )?.mapping ?? resolvedCast.value[0]?.mapping,
);
const activeCharacterName = computed(
  () => activeMapping.value?.agent_character_name ?? "当前角色",
);
const castCharacterNames = computed(
  () => resolvedCast.value.map((member) => member.mapping.agent_character_name).join("、"),
);
const activeActorFollowsPlayer = computed(
  () => actor(activeActorId.value)?.following_actor_id === currentPlayerActorId.value,
);

let runtime: StageRuntime | null = null;
let game: StageGame | null = null;
let agentClient: AgentApiClient | null = null;
let unsubscribe: (() => void) | null = null;
let snapshotTimer: number | null = null;
let generation = 0;
let commandSequence = 0;
let conversationSequence = 0;
let portalTransitionPending = false;
let portalTransitionTimer: number | null = null;
let runPortalTransition: (() => void) | null = null;
const worldPresence = new WorldPresence();
const PORTAL_TRANSITION_FALLBACK_MS = 750;
const PORTAL_TRANSITION_AFTER_COMMAND_MS = 50;

onMounted(() => void initializeApplication());
onBeforeUnmount(dispose);

async function initializeApplication(): Promise<void> {
  await initialize();
  if (store.phase !== "ready") return;
  await prepareAgentSession();
}

async function initialize(options: StageInitializationOptions = {}): Promise<void> {
  if (!options.skipPresenceSync && runtime) {
    worldPresence.syncScene(runtime.scene, runtime.snapshot());
  }
  const currentGeneration = ++generation;
  dispose(false);
  portalTransitionPending = false;
  store.reset();
  actorViews.value = [];
  try {
    const [registry, stageRegistry, mapping] = await Promise.all([
      loadCharacterRegistry(contentUrl("characters/registry.json")),
      loadStageRegistry(contentUrl("stages/registry.json")),
      loadCharacterMapping(contentUrl("characters/agent-mapping.json")),
    ]);
    characterMappings.value = mapping.characters;
    normalizeSelectedCast(mapping.characters);
    const cast = resolveCast(mapping.characters);
    if (cast.length === 0) throw new Error("出演角色为空");
    if (!cast.some((member) => member.mapping.stage_actor_id === activeActorId.value)) {
      activeActorId.value = cast[0]!.mapping.stage_actor_id;
    }

    const requestedStagePath =
      options.definitionPath || activeStagePath.value || stageRegistry.default_definition_path;
    const sourceStage = await loadStage(contentUrl(requestedStagePath));
    const castStage = applyStageCast(
      sourceStage,
      cast.map((member) => ({ mapping: member.mapping, outfit: member.outfit })),
    );
    const registryByBundle = new Map(
      registry.characters.map((entry) => [entry.bundle_id, entry]),
    );
    const [sourceScene, renderer] = await Promise.all([
      loadScene(contentUrl(castStage.scene_path)),
      import("@uma-stage/renderer-phaser"),
    ]);
    const castActorIds = castStage.actors.map((actorDefinition) => actorDefinition.instance_id);
    if (options.resetWorld) worldPresence.resetActors(castActorIds, sourceScene.scene_id);
    else worldPresence.reconcileActors(castActorIds, sourceScene.scene_id);
    const scenePresences = worldPresence.actorsInScene(sourceScene.scene_id);
    const presentActorIds = new Set(scenePresences.map((presence) => presence.actor_id));
    const stage: StageDefinition = {
      ...castStage,
      actors: castStage.actors.filter((actorDefinition) =>
        presentActorIds.has(actorDefinition.instance_id),
      ),
    };
    if (stage.actors.length === 0) {
      throw new Error(`场景 ${sourceScene.scene_id} 中没有可装载角色`);
    }
    const packs = await Promise.all(
      stage.actors.map((actorDefinition) => {
        const entry = registryByBundle.get(actorDefinition.bundle_id);
        if (!entry) {
          throw new Error(`舞台引用了未注册角色：${actorDefinition.bundle_id}`);
        }
        return loadActor(contentUrl(entry.actor_path));
      }),
    );
    const placement = placeScenePresences(
      sourceScene,
      scenePresences,
      options.spawnOverrides,
    );
    const spawnOverrides = placement.spawnOverrides;
    const scene = ensureSceneSpawnCapacity(
      placement.scene,
      stage.actors.length,
      stage.actors.map(
        (actorDefinition) =>
          spawnOverrides[actorDefinition.instance_id] ?? actorDefinition.spawn_id,
      ),
    );
    if (currentGeneration !== generation) return;

    const nextRuntime = new StageRuntime(scene);
    const playerActorId = stage.actors.find(
      (actorDefinition) => actorDefinition.player,
    )?.instance_id;
    const assignedSpawns = assignStageSpawns(stage.actors, scene, spawnOverrides);
    const rendererActors = stage.actors.map((actorDefinition, index) => {
      const pack = packs[index];
      if (!pack) throw new Error(`缺少角色包：${actorDefinition.bundle_id}`);
      const registryEntry = registryByBundle.get(actorDefinition.bundle_id);
      if (!registryEntry) throw new Error(`缺少角色注册项：${actorDefinition.bundle_id}`);
      nextRuntime.spawnActor({
        actorId: actorDefinition.instance_id,
        characterPack: pack,
        spawnId: assignedSpawns[actorDefinition.instance_id] ?? actorDefinition.spawn_id,
        controlOwner: actorDefinition.control_owner,
      });
      return {
        actorId: actorDefinition.instance_id,
        pack,
        bundleBaseUrl: contentDirectoryUrl(registryEntry.actor_path),
      };
    });
    const followBindings = uniqueFollowBindings([
      ...worldPresence.followBindingsInScene(scene.scene_id),
      ...(options.followBindings ?? []),
    ]);
    for (const binding of followBindings) {
      if (!stage.actors.some((actorDefinition) => actorDefinition.instance_id === binding.actorId)) continue;
      if (!stage.actors.some((actorDefinition) => actorDefinition.instance_id === binding.targetActorId)) continue;
      nextRuntime.execute({
        id: nextCommandId("portal-follow"),
        type: "actor.follow",
        actor_id: binding.actorId,
        target_actor_id: binding.targetActorId,
        distance_tiles: binding.distanceTiles,
        preferred_side: binding.targetActorId === playerActorId ? "above" : "nearest",
        source: "system",
        policy: "replace",
      });
    }
    runtime = nextRuntime;
    unsubscribe = nextRuntime.subscribe((event) => {
      store.pushEvent(event);
      handlePortalEvent(event, playerActorId, stageRegistry);
    });
    store.setSnapshot(nextRuntime.snapshot());
    stageName.value = stage.display_name;
    currentStageId.value = stage.stage_id;
    stageChoices.value = stageRegistry.stages;
    activeStagePath.value = requestedStagePath;
    currentSceneId.value = scene.scene_id;
    currentPlayerActorId.value = playerActorId ?? "";
    if (!stage.actors.some((actorDefinition) => actorDefinition.instance_id === activeActorId.value)) {
      activeActorId.value = stage.actors.find((actorDefinition) => !actorDefinition.player)?.instance_id ?? "";
    }
    sceneAnchors.value = scene.anchors.map((anchor) => ({
      id: anchor.id,
      displayName: anchor.display_name,
    }));
    sceneZones.value = scene.zones.map((zone) => ({
      id: zone.id,
      displayName: zone.display_name,
    }));
    activityPaths.value = scene.activity_paths.map((path) => ({
      id: path.id,
      activityId: path.activity_id,
    }));
    actorViews.value = stage.actors.map((actorDefinition, index) => ({
      instanceId: actorDefinition.instance_id,
      displayName: packs[index]?.display_name ?? actorDefinition.instance_id,
      player: actorDefinition.player,
      initials: initials(packs[index]?.display_name ?? actorDefinition.instance_id),
    }));

    const parent = stageElement.value;
    if (!parent) throw new Error("舞台挂载点不存在");
    game = renderer.createStageGame({
      parent,
      runtime: nextRuntime,
      scene,
      sceneBaseUrl: contentDirectoryUrl(castStage.scene_path),
      ...(playerActorId === undefined ? {} : { playerActorId }),
      actors: rendererActors,
      environment: stageEnvironment.value,
    });
    snapshotTimer = window.setInterval(() => {
      if (runtime) store.setSnapshot(runtime.snapshot());
    }, 100);
    worldPresence.syncScene(scene, nextRuntime.snapshot());
    store.ready();
  } catch (error) {
    if (currentGeneration === generation) store.fail(error);
  }
}

function normalizeSelectedCast(mappings: CharacterAgentMappingEntry[]): void {
  const available = new Set(mappings.map((mapping) => mapping.character_id));
  const seen = new Set<string>();
  const normalized = selectedCast.value.filter((selection) => {
    if (!available.has(selection.characterId) || seen.has(selection.characterId)) return false;
    seen.add(selection.characterId);
    return true;
  });
  const first = mappings[0];
  if (normalized.length === 0 && first) {
    normalized.push({ characterId: first.character_id, outfit: "uniform" });
  }
  selectedCast.value = normalized.slice(0, 4);
}

function resolveCast(mappings = characterMappings.value): ResolvedCastMember[] {
  return selectedCast.value.flatMap((selection) => {
    const mapping = mappings.find((entry) => entry.character_id === selection.characterId);
    return mapping ? [{ ...selection, mapping }] : [];
  });
}

function mappingFor(characterId: string): CharacterAgentMappingEntry | undefined {
  return characterMappings.value.find((entry) => entry.character_id === characterId);
}

function castKey(): string {
  return resolveCast()
    .map((member) => member.mapping.character_id)
    .join("|");
}

function isCharacterSelectedElsewhere(characterId: string, castIndex: number): boolean {
  return selectedCast.value.some(
    (selection, index) => index !== castIndex && selection.characterId === characterId,
  );
}

function handlePortalEvent(
  event: StageEvent,
  playerActorId: string | undefined,
  stageRegistry: StageRegistry,
): void {
  if (
    portalTransitionPending &&
    event.type === "command.completed" &&
    event.actor_id === playerActorId &&
    runPortalTransition
  ) {
    if (portalTransitionTimer !== null) window.clearTimeout(portalTransitionTimer);
    portalTransitionTimer = window.setTimeout(
      runPortalTransition,
      PORTAL_TRANSITION_AFTER_COMMAND_MS,
    );
    return;
  }
  if (
    portalTransitionPending ||
    event.type !== "portal.entered" ||
    event.actor_id !== playerActorId
  ) return;
  const targetSceneId = event.data.target_scene_id;
  const targetSpawnId = event.data.target_spawn_id;
  if (typeof targetSceneId !== "string" || typeof targetSpawnId !== "string") return;
  const target = stageRegistry.stages.find((entry) => entry.scene_id === targetSceneId);
  if (!target || !playerActorId) return;
  portalTransitionPending = true;
  store.setMessage(`区域切换：前往${target.display_name}`);
  runPortalTransition = () => {
    portalTransitionTimer = null;
    runPortalTransition = null;
    const activeRuntime = runtime;
    if (!activeRuntime) return;
    worldPresence.syncScene(activeRuntime.scene, activeRuntime.snapshot());
    const partyActorIds = worldPresence.transferFollowingParty(
      playerActorId,
      activeRuntime.scene.scene_id,
      targetSceneId,
      targetSpawnId,
    );
    void initialize({
      definitionPath: target.definition_path,
      spawnOverrides: Object.fromEntries(
        partyActorIds.map((actorId) => [actorId, targetSpawnId]),
      ),
      skipPresenceSync: true,
    });
  };
  portalTransitionTimer = window.setTimeout(
    runPortalTransition,
    PORTAL_TRANSITION_FALLBACK_MS,
  );
}

function dispose(invalidate = true): void {
  if (invalidate) generation += 1;
  if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
  snapshotTimer = null;
  if (portalTransitionTimer !== null) window.clearTimeout(portalTransitionTimer);
  portalTransitionTimer = null;
  runPortalTransition = null;
  unsubscribe?.();
  unsubscribe = null;
  game?.destroy();
  game = null;
  runtime = null;
}

async function changeCast(castIndex?: number): Promise<void> {
  normalizeSelectedCast(characterMappings.value);
  if (castIndex !== undefined) {
    const selected = selectedCast.value[castIndex];
    const mapping = selected && mappingFor(selected.characterId);
    if (mapping) activeActorId.value = mapping.stage_actor_id;
  }
  agentSession.value = null;
  conversation.value = [];
  await initialize({ definitionPath: activeStagePath.value });
  if (store.phase === "ready") await prepareAgentSession();
}

async function runPerformanceDemo(): Promise<void> {
  if (performanceRunning.value) return;
  performanceRunning.value = true;
  agentSession.value = null;
  conversation.value = [];
  try {
    const script = await loadPerformance(
      contentUrl("performances/admire-vega-starlight.anime.json"),
    );
    const characterCast = script.cast.filter((member) => member.character_id !== "trainer");
    if (characterCast.length === 0 || characterCast.length > 4) {
      throw new Error(`当前 Stage 支持 1–4 位角色，剧本声明了 ${characterCast.length} 位`);
    }
    selectedCast.value = characterCast.map((member) => ({
      characterId: member.character_id,
      outfit: performanceOutfit(member.outfit_id),
    }));
    normalizeSelectedCast(characterMappings.value);
    activeActorId.value = resolveCast()[0]?.mapping.stage_actor_id ?? "";
    pushConversation("system", "演出", `开始《${script.title}》`);

    for (const performanceScene of script.scenes) {
      const stage = stageChoices.value.find(
        (choice) => choice.stage_id === performanceScene.stage_id,
      );
      if (!stage) throw new Error(`剧本引用了未知舞台：${performanceScene.stage_id}`);
      const actorIdsBeforeLoad = performanceRoleBindings(script, "trainer");
      const spawnOverrides = Object.fromEntries(
        performanceScene.placements.flatMap((placement) => {
          const actorId = actorIdsBeforeLoad[placement.role_id];
          return actorId && placement.spawn_id ? [[actorId, placement.spawn_id]] : [];
        }),
      );
      if (performanceScene.environment) {
        stageEnvironment.value = stageEnvironmentSchema.parse(performanceScene.environment);
      }
      await initialize({
        definitionPath: stage.definition_path,
        spawnOverrides,
        resetWorld: true,
      });
      if (store.phase !== "ready" || !runtime) {
        throw new Error(store.error || `无法装载剧本舞台：${stage.display_name}`);
      }
      await applyPerformancePlacements(script, performanceScene);
      await executePerformanceScene(script, performanceScene);
    }
    restoreLiveControl(script);
    store.setMessage(`《${script.title}》演出完成`);
    pushConversation("system", "演出", `《${script.title}》演出完成`);
  } catch (error) {
    restoreLiveControl();
    store.setMessage(`剧本演出失败：${errorMessage(error)}`);
    pushConversation("system", "演出", `失败：${errorMessage(error)}`);
  } finally {
    performanceRunning.value = false;
  }
}

async function applyPerformancePlacements(
  script: PerformanceScript,
  scene: PerformanceScript["scenes"][number],
): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("舞台 Runtime 尚未就绪");
  const actorIdsByRole = performanceRoleBindings(script, currentPlayerActorId.value);
  const tasks = scene.placements.flatMap((placement) => {
    if (!placement.facing) return [];
    const actorId = actorIdsByRole[placement.role_id];
    if (!actorId) throw new Error(`剧本站位没有角色绑定：${placement.role_id}`);
    return [activeRuntime.execute({
      id: nextCommandId("placement-face"),
      type: "actor.face",
      actor_id: actorId,
      facing: placement.facing,
      source: "system",
      policy: "replace",
    }).completion];
  });
  const results = await Promise.all(tasks);
  const failed = results.find((result) => result.status !== "completed");
  if (failed) {
    throw new Error(`剧本站位朝向失败：${failed.error?.message ?? failed.status}`);
  }
}

async function executePerformanceScene(
  script: PerformanceScript,
  scene: PerformanceScript["scenes"][number],
): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("舞台 Runtime 尚未就绪");
  const actorIdsByRole = performanceRoleBindings(script, currentPlayerActorId.value);
  for (const actorId of Object.values(actorIdsByRole)) {
    activeRuntime.setControlOwner(actorId, "script");
  }
  const backgroundTasks: Array<Promise<void>> = [];

  for (const beat of scene.beats) {
    if (runtime !== activeRuntime) throw new Error("剧本执行期间舞台已切换");
    const tasks = beat.cues.map((cue) =>
      executePerformanceCue(script, cue, actorIdsByRole, activeRuntime),
    );
    if (beat.wait_for === "all") await Promise.all(tasks);
    else backgroundTasks.push(...tasks);
    if (beat.hold_ms > 0) await delay(beat.hold_ms);
  }
  await Promise.all(backgroundTasks);
}

async function executePerformanceCue(
  script: PerformanceScript,
  cue: PerformanceCue,
  actorIdsByRole: Readonly<Record<string, string>>,
  activeRuntime: StageRuntime,
): Promise<void> {
  const compiled = compilePerformanceCue(cue, actorIdsByRole);
  if (compiled.kind === "camera") {
    game?.setCameraCue(compiled.cue);
    return;
  }
  if (compiled.kind === "wait") {
    await delay(compiled.durationMs);
    return;
  }
  if (compiled.kind === "narration") {
    pushConversation(
      "narrator",
      "环境",
      compiled.subtitleZh ?? compiled.subtitleJa ?? compiled.text,
    );
    if (compiled.durationMs) await delay(compiled.durationMs);
    return;
  }
  if (cue.type === "dialogue.say") {
    const member = script.cast.find((candidate) => candidate.role_id === cue.role_id);
    pushConversation(
      "character",
      member?.display_name ?? member?.character_id ?? cue.role_id,
      cue.subtitle_zh ?? cue.subtitle_ja ?? cue.text,
    );
  }
  const result = await activeRuntime.execute(compiled.command).completion;
  if (result.status !== "completed") {
    throw new Error(
      `Cue ${cue.cue_id} ${result.status}: ${result.error?.message ?? "未知原因"}`,
    );
  }
}

function performanceRoleBindings(
  script: PerformanceScript,
  trainerActorId: string,
): Record<string, string> {
  return Object.fromEntries(
    script.cast.map((member) => {
      if (member.character_id === "trainer") {
        return [member.role_id, trainerActorId || "trainer"];
      }
      const mapping = characterMappings.value.find(
        (candidate) => candidate.character_id === member.character_id,
      );
      if (!mapping) {
        throw new Error(`剧本角色没有 Stage 映射：${member.character_id}`);
      }
      return [member.role_id, mapping.stage_actor_id];
    }),
  );
}

function performanceOutfit(outfitId: string): StageCastOutfit {
  if (outfitId === "uniform" || outfitId === "race_outfit") return outfitId;
  throw new Error(`Stage 不支持角色服装：${outfitId}`);
}

function restoreLiveControl(script?: PerformanceScript): void {
  const activeRuntime = runtime;
  if (!activeRuntime) return;
  const bindings = script
    ? performanceRoleBindings(script, currentPlayerActorId.value)
    : Object.fromEntries(
        activeRuntime.snapshot().actors.map((state) => [state.actor_id, state.actor_id]),
      );
  for (const actorId of new Set(Object.values(bindings))) {
    const state = activeRuntime
      .snapshot()
      .actors.find((candidate) => candidate.actor_id === actorId);
    if (!state) continue;
    activeRuntime.setControlOwner(
      actorId,
      actorId === currentPlayerActorId.value ? "player" : "agent",
    );
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

async function changeCastOutfit(): Promise<void> {
  await initialize({ definitionPath: activeStagePath.value });
}

async function addCastMember(): Promise<void> {
  const used = new Set(selectedCast.value.map((selection) => selection.characterId));
  const mapping = characterMappings.value.find(
    (entry) => !used.has(entry.character_id) && isAgentCharacterAvailable(entry),
  );
  if (!mapping || selectedCast.value.length >= 4) return;
  selectedCast.value.push({ characterId: mapping.character_id, outfit: "uniform" });
  activeActorId.value = mapping.stage_actor_id;
  await changeCast();
}

async function removeCastMember(index: number): Promise<void> {
  if (selectedCast.value.length <= 1) return;
  const removed = selectedCast.value[index];
  selectedCast.value.splice(index, 1);
  if (mappingFor(removed?.characterId ?? "")?.stage_actor_id === activeActorId.value) {
    activeActorId.value = resolveCast()[0]?.mapping.stage_actor_id ?? "";
  }
  await changeCast();
}

function selectActiveActor(actorId: string): void {
  if (!resolvedCast.value.some((member) => member.mapping.stage_actor_id === actorId)) return;
  activeActorId.value = actorId;
}

async function runMeeting(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "script");
  store.setMessage(`脚本接管：${activeCharacterName.value}正在前往喷泉会面点`);
  const movement = activeRuntime.execute({
    id: nextCommandId("meeting"),
    type: "actor.move_to",
    actor_id: actorId,
    source: "script",
    policy: "replace",
    target: { type: "anchor", id: "fountain_meeting" },
  });
  const result = await movement.completion;
  if (activeRuntime !== runtime || result.status !== "completed") {
    describeResult(result);
    return;
  }
  store.setMessage(`${activeCharacterName.value}已到达交互槽位`);
  const speech = activeRuntime.execute({
    id: nextCommandId("say"),
    type: "dialogue.say",
    actor_id: actorId,
    source: "script",
    policy: "replace",
    text: "训练员，下一项安排是什么？",
  });
  await speech.completion;
  if (activeRuntime === runtime) {
    activeRuntime.setControlOwner(actorId, "agent");
    store.setMessage("演出完成，控制权已归还 agent");
  }
}

async function sendActorTo(anchorId: string, label: string): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  store.setMessage(`agent 指令：${activeCharacterName.value}前往${label}`);
  const task = activeRuntime.execute({
    id: nextCommandId("move"),
    type: "actor.move_to",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
    target: { type: "anchor", id: anchorId },
  });
  const result = await task.completion;
  if (activeRuntime === runtime) describeResult(result, `${label}已到达`);
}

async function runActivityPath(pathId: string, activityId: string): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  store.setMessage(`agent 指令：${activeCharacterName.value}执行 ${activityId}`);
  const task = activeRuntime.execute({
    id: nextCommandId("activity"),
    type: "actor.follow_activity_path",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
    activity_path_id: pathId,
    cycles: 1,
  });
  const result = await task.completion;
  if (activeRuntime === runtime) describeResult(result, `${activityId} 已完成`);
}

async function startActorFollow(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  const targetActorId = currentPlayerActorId.value;
  if (!activeRuntime || !targetActorId) return;
  activeRuntime.setControlOwner(actorId, "agent");
  const result = await activeRuntime.execute({
    id: nextCommandId("follow"),
    type: "actor.follow",
    actor_id: actorId,
    target_actor_id: targetActorId,
    distance_tiles: 2,
    preferred_side: "above",
    source: "agent",
    policy: "replace",
  }).completion;
  if (activeRuntime === runtime) describeResult(result, `${activeCharacterName.value}会持续跟随训练员`);
}

async function stopActorFollow(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  const result = await activeRuntime.execute({
    id: nextCommandId("stop-follow"),
    type: "actor.stop_follow",
    actor_id: actorId,
    source: "agent",
    policy: "replace",
  }).completion;
  if (activeRuntime === runtime) describeResult(result, `${activeCharacterName.value}已停止跟随`);
}

function followCamera(actorId: string): void {
  game?.setCameraCue({
    type: "camera.follow_actor",
    actor_id: actorId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function focusCameraOnAnchor(anchorId: string): void {
  game?.setCameraCue({
    type: "camera.focus_anchor",
    anchor_id: anchorId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function focusCameraOnZone(zoneId: string): void {
  game?.setCameraCue({
    type: "camera.focus_zone",
    zone_id: zoneId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function showCameraOverview(): void {
  game?.setCameraCue({ type: "camera.overview", transition_ms: 600 });
}

function applyStageEnvironment(): void {
  stageEnvironment.value = stageEnvironmentSchema.parse(stageEnvironment.value);
  game?.setEnvironment(stageEnvironment.value);
}

function changeStageFromSelect(event: Event): void {
  const definitionPath = (event.target as HTMLSelectElement).value;
  if (!definitionPath || definitionPath === activeStagePath.value) return;
  void initialize({ definitionPath, resetWorld: true });
}

function resetCurrentScene(): void {
  void initialize({
    ...(activeStagePath.value ? { definitionPath: activeStagePath.value } : {}),
    resetWorld: true,
  });
}

async function connectAgent(): Promise<boolean> {
  agentStatus.value = "connecting";
  agentStatusMessage.value = "正在从 .env 配置连接 Agent…";
  try {
    const client = new AgentApiClient({
      baseUrl: defaultAgentUrl,
      apiKey: configuredAgentKey,
    });
    const [characters] = await Promise.all([
      client.listCharacters(),
      client.stageCapabilities(),
    ]);
    agentClient = client;
    agentCharacters.value = characters;
    agentStatus.value = "connected";
    agentStatusMessage.value = `已连接 · Agent ${characters.length} 角色 / Stage ${characterMappings.value.length} 角色`;
    return true;
  } catch (error) {
    agentClient = null;
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
    return false;
  }
}

async function prepareAgentSession(): Promise<boolean> {
  if (!(await connectAgent())) return false;
  return createAgentSession();
}

async function createAgentSession(): Promise<boolean> {
  const cast = resolveCast();
  if (cast.length === 0) return false;
  if (!agentClient && !(await connectAgent())) return false;
  if (!agentClient) return false;
  const unavailable = cast.filter(
    (member) => !agentCharacters.value.includes(member.mapping.agent_character_name),
  );
  if (unavailable.length > 0) {
    agentStatus.value = "error";
    agentStatusMessage.value = `Agent 尚未提供角色：${unavailable.map((member) => member.mapping.agent_character_name).join("、")}`;
    return false;
  }
  agentStatus.value = "busy";
  agentStatusMessage.value = `正在加载 ${cast.length} 位出演角色…`;
  try {
    const session = await agentClient.createStageSession({
      characterNames: cast.map((member) => member.mapping.agent_character_name),
      sceneName: stageName.value,
    });
    const sessionActors = cast.map((member) => {
      const agentActor = session.actors.find(
        (actor) =>
          actor.actorType === "umamusume" &&
          actor.displayName === member.mapping.agent_character_name,
      );
      if (!agentActor) {
        throw new Error(
          `Agent 会话未返回角色 actor_id：${member.mapping.agent_character_name}`,
        );
      }
      return {
        characterId: member.mapping.character_id,
        displayName: member.mapping.agent_character_name,
        agentActorId: agentActor.actorId,
        stageActorId: member.mapping.stage_actor_id,
      };
    });
    agentSession.value = {
      sessionId: session.sessionId,
      userUuid: session.userUuid,
      castKey: castKey(),
      actors: sessionActors,
    };
    conversation.value = [];
    pushConversation(
      "system",
      "舞台",
      `${cast.map((member) => member.mapping.agent_character_name).join("、")} 已进入多人角色会话`,
    );
    agentStatus.value = "connected";
    agentStatusMessage.value = `${cast.length} 位角色会话已就绪`;
    return true;
  } catch (error) {
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
    return false;
  }
}

async function sendAgentMessage(): Promise<void> {
  const message = agentInput.value.trim();
  const cast = resolveCast();
  const activeRuntime = runtime;
  if (!message || cast.length === 0 || !activeRuntime || agentStatus.value === "busy") return;
  if (!agentSession.value || agentSession.value.castKey !== castKey()) {
    if (!(await createAgentSession())) return;
  }
  const session = agentSession.value;
  if (!session || !agentClient) return;
  const presentStageActorIds = new Set(
    activeRuntime.snapshot().actors.map((state) => state.actor_id),
  );
  const presentSessionActors = session.actors.filter((actorBinding) =>
    presentStageActorIds.has(actorBinding.stageActorId),
  );
  if (presentSessionActors.length === 0) {
    agentStatus.value = "connected";
    agentStatusMessage.value = "当前地图没有可对话的出演角色";
    return;
  }

  agentInput.value = "";
  pushConversation("trainer", "训练员", message);
  agentStatus.value = "busy";
  agentStatusMessage.value = "角色正在生成对白与舞台行为…";
  try {
    const liveStage = agentLiveStageSchema.parse({
      schema_version: "live_stage.v1",
      stage_id: currentStageId.value,
      scene_id: currentSceneId.value,
      ...activeRuntime.inspect(),
    });
    const result = await agentClient.turn({
      sessionId: session.sessionId,
      userUuid: session.userUuid,
      message,
      targetActorIds: presentSessionActors.map((actorBinding) => actorBinding.agentActorId),
      actorBindings: presentSessionActors.map((actorBinding) => ({
        agent_actor_id: actorBinding.agentActorId,
        stage_actor_id: actorBinding.stageActorId,
      })),
      liveStage,
    });
    const pendingReplies: PendingAgentReply[] = result.events.flatMap((event) => {
      if (event.event_type !== "character_reply") return [];
      const actorBinding = session.actors.find(
        (candidate) => candidate.agentActorId === event.actor?.actor_id,
      );
      return [{
        event,
        stageActorId: actorBinding?.stageActorId ?? null,
        actionShown: false,
        dialogueShown: false,
      }];
    });
    for (const event of result.events) {
      if (event.event_type === "narration" || event.event_type === "scene_change") {
        pushConversation("narrator", "环境", event.content);
      }
    }
    const actions = reconcileStageTurnActions(result, presentSessionActors.map((actorBinding) => ({
      agent_actor_id: actorBinding.agentActorId,
      stage_actor_id: actorBinding.stageActorId,
    })));
    if (activeRuntime !== runtime) {
      throw new Error("Agent 返回期间舞台已切换，请重新发送本轮消息");
    }
    const boundStageActorIds = new Set(
      presentSessionActors.map((actorBinding) => actorBinding.stageActorId),
    );
    const worldActions: Array<Extract<AgentStageAction, { type: "actor.travel_to_scene" }>> = [];
    for (const action of actions) {
      if (!boundStageActorIds.has(action.actor_id)) {
        throw new Error(`Agent 返回了未绑定角色动作：${action.actor_id}`);
      }
      pushConversation("command", "StageCommand", formatAgentAction(action));
      revealReplyForAgentAction(pendingReplies, action);
      if (action.type === "actor.travel_to_scene") {
        worldActions.push(action);
        continue;
      }
      const state = activeRuntime
        .snapshot()
        .actors.find((candidate) => candidate.actor_id === action.actor_id);
      if (state?.control_owner !== "agent") {
        activeRuntime.setControlOwner(action.actor_id, "agent");
      }
      const command = stageActionToCommand(action, nextCommandId("agent"));
      const commandResult = await activeRuntime.execute(command).completion;
      if (commandResult.status !== "completed") {
        throw new Error(
          `舞台动作执行失败（${formatAgentAction(action)}）：${commandResult.status}` +
          `${commandResult.error?.message ? ` · ${commandResult.error.message}` : ""}`,
        );
      }
    }
    revealPendingAgentReplies(pendingReplies);
    for (const action of worldActions) await executeDirectorTravel(action);
    agentStatus.value = "connected";
    agentStatusMessage.value = `第 ${result.turn_index} 轮完成 · ${actions.length} 条舞台动作`;
  } catch (error) {
    agentStatus.value = "error";
    agentStatusMessage.value = errorMessage(error);
  }
}

async function executeDirectorTravel(
  action: Extract<AgentStageAction, { type: "actor.travel_to_scene" }>,
): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("舞台 Runtime 尚未就绪");
  const target = stageChoices.value.find(
    (entry) => entry.scene_id === action.target_scene_id,
  );
  if (!target) throw new Error(`Director 引用了未知场景：${action.target_scene_id}`);
  if (!activeRuntime.snapshot().actors.some((state) => state.actor_id === action.actor_id)) {
    throw new Error(`角色不在当前场景：${action.actor_id}`);
  }
  worldPresence.syncScene(activeRuntime.scene, activeRuntime.snapshot());
  worldPresence.transferActor(
    action.actor_id,
    action.target_scene_id,
    action.target_spawn_id ?? null,
  );
  const playerTravels = action.actor_id === currentPlayerActorId.value;
  await initialize({
    definitionPath: playerTravels ? target.definition_path : activeStagePath.value,
    skipPresenceSync: true,
  });
  if (store.phase !== "ready") {
    throw new Error(store.error || `无法完成跨场景移动：${target.display_name}`);
  }
  store.setMessage(
    playerTravels
      ? `训练员已前往${target.display_name}`
      : `${action.actor_id}已单独前往${target.display_name}`,
  );
}

function revealReplyForAgentAction(
  replies: PendingAgentReply[],
  action: AgentStageAction,
): void {
  if (action.type === "dialogue.say") {
    const normalizedText = action.text.trim();
    const reply =
      replies.find(
        (candidate) =>
          !candidate.dialogueShown &&
          candidate.stageActorId === action.actor_id &&
          (candidate.event.dialogue.trim() || candidate.event.content.trim()) === normalizedText,
      ) ??
      replies.find(
        (candidate) =>
          !candidate.dialogueShown && candidate.stageActorId === action.actor_id,
      );
    if (!reply) return;
    revealAgentReplyAction(reply);
    pushConversation(
      "character",
      reply.event.actor?.display_name ?? activeCharacterName.value,
      reply.event.dialogue || reply.event.content,
    );
    reply.dialogueShown = true;
    return;
  }

  const reply = replies.find(
    (candidate) => !candidate.actionShown && candidate.stageActorId === action.actor_id,
  );
  if (reply) revealAgentReplyAction(reply);
}

function revealAgentReplyAction(reply: PendingAgentReply): void {
  if (reply.actionShown || !reply.event.action.trim()) return;
  pushConversation(
    "action",
    reply.event.actor?.display_name ?? activeCharacterName.value,
    reply.event.action,
  );
  reply.actionShown = true;
}

function revealPendingAgentReplies(replies: PendingAgentReply[]): void {
  for (const reply of replies) {
    revealAgentReplyAction(reply);
    if (reply.dialogueShown) continue;
    pushConversation(
      "character",
      reply.event.actor?.display_name ?? activeCharacterName.value,
      reply.event.dialogue || reply.event.content,
    );
    reply.dialogueShown = true;
  }
}

function isAgentCharacterAvailable(mapping: CharacterAgentMappingEntry): boolean {
  return agentCharacters.value.length === 0 || agentCharacters.value.includes(mapping.agent_character_name);
}

function pushConversation(
  kind: ConversationLine["kind"],
  speaker: string,
  text: string,
): void {
  if (!text.trim()) return;
  conversationSequence += 1;
  conversation.value.push({
    id: `line-${conversationSequence}`,
    speaker,
    text: text.trim(),
    kind,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentApiError) {
    const detail = typeof error.detail === "string" ? `：${error.detail}` : "";
    return `Agent API ${error.status}${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatAgentAction(action: AgentStageAction): string {
  if (action.type === "actor.move_to") {
    return `move_to → ${action.anchor_id}${action.slot_id ? ` / ${action.slot_id}` : ""}`;
  }
  if (action.type === "actor.approach") {
    return `approach → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  }
  if (action.type === "actor.follow") {
    return `follow → ${action.target_actor_id} / ${action.distance_tiles} tile`;
  }
  if (action.type === "actor.stop_follow") return "stop_follow";
  if (action.type === "actor.travel_to_scene") {
    return `travel_to_scene → ${action.target_scene_id}${action.target_spawn_id ? ` / ${action.target_spawn_id}` : ""}`;
  }
  if (action.type === "actor.face") return `face → ${action.facing}`;
  if (action.type === "actor.face_actor") return `face_actor → ${action.target_actor_id}`;
  if (action.type === "dialogue.say") return `say → ${action.text}`;
  return "stop";
}

function describeResult(result: CommandResult, success = "移动完成"): void {
  store.setMessage(
    result.status === "completed"
      ? success
      : `${result.status}: ${result.error?.message ?? "未知原因"}`,
  );
}

function actor(actorId: string): StageActorState | undefined {
  return store.snapshot?.actors.find((candidate) => candidate.actor_id === actorId);
}

function uniqueFollowBindings(bindings: FollowBinding[]): FollowBinding[] {
  return [...new Map(bindings.map((binding) => [binding.actorId, binding])).values()];
}

function nextCommandId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${commandSequence}`;
}

async function loadScene(url: string): Promise<ScenePack> {
  return scenePackSchema.parse(await fetchJson(url));
}

async function loadActor(url: string): Promise<CharacterPack> {
  return characterPackSchema.parse(await fetchJson(url));
}

async function loadCharacterRegistry(url: string): Promise<CharacterRegistry> {
  return characterRegistrySchema.parse(await fetchJson(url));
}

async function loadCharacterMapping(url: string): Promise<CharacterAgentMapping> {
  return characterAgentMappingSchema.parse(await fetchJson(url));
}

async function loadStageRegistry(url: string): Promise<StageRegistry> {
  return stageRegistrySchema.parse(await fetchJson(url));
}

async function loadStage(url: string): Promise<StageDefinition> {
  return stageDefinitionSchema.parse(await fetchJson(url));
}

async function loadPerformance(url: string): Promise<PerformanceScript> {
  const payload = await fetchJson(url);
  const animeScript = animeStageScriptSchema.safeParse(payload);
  return animeScript.success
    ? compileAnimeStageScript(animeScript.data)
    : performanceScriptSchema.parse(payload);
}

function contentUrl(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${import.meta.env.BASE_URL}${encoded}`;
}

function contentDirectoryUrl(path: string): string {
  return contentUrl(path.split("/").slice(0, -1).join("/"));
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  }
  return name.slice(0, 2);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 ${url} (${response.status})`);
  return response.json() as Promise<unknown>;
}

function formatEvent(event: (typeof store.events)[number]): string {
  const actorName =
    actorViews.value.find((view) => view.instanceId === event.actor_id)?.displayName ?? "stage";
  return `${String(event.sequence).padStart(2, "0")} · ${actorName} · ${event.type}`;
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand-block">
        <span class="eyebrow">UMA STAGE / PLAYABLE TEST</span>
        <h1>{{ stageName }}</h1>
      </div>
      <div class="status-block">
        <div class="stage-health" :class="store.phase">
          <span class="health-dot"></span>
          <span>{{ store.message }}</span>
        </div>
        <div class="service-badges">
          <span class="service-status" :class="agentStatus">AGENT · {{ agentStatus }}</span>
        </div>
      </div>
    </header>

    <section class="character-toolbar">
      <div class="cast-toolbar-heading">
        <div>
          <span class="eyebrow">CAST · {{ selectedCast.length }} / 4</span>
          <strong>出演角色与当前测试角色</strong>
        </div>
        <button
          type="button"
          :disabled="selectedCast.length >= 4 || store.phase === 'loading' || agentStatus === 'busy' || performanceRunning"
          @click="addCastMember"
        >
          ＋ 添加角色
        </button>
      </div>
      <div class="cast-list">
        <article
          v-for="(member, index) in selectedCast"
          :key="`${index}-${member.characterId}`"
          class="cast-row"
          :class="{ active: mappingFor(member.characterId)?.stage_actor_id === activeActorId }"
        >
          <button
            class="cast-focus"
            type="button"
            :aria-label="`选择第 ${index + 1} 位角色作为当前测试角色`"
            @click="selectActiveActor(mappingFor(member.characterId)?.stage_actor_id ?? '')"
          >
            {{ mappingFor(member.characterId)?.stage_actor_id === activeActorId ? '当前' : `#${index + 1}` }}
          </button>
          <label>
            <span>出演角色</span>
            <select
              v-model="member.characterId"
              :disabled="store.phase === 'loading' || agentStatus === 'connecting' || agentStatus === 'busy' || performanceRunning"
              @change="changeCast(index)"
            >
              <option
                v-for="mapping in characterMappings"
                :key="mapping.character_id"
                :value="mapping.character_id"
                :disabled="!isAgentCharacterAvailable(mapping) || isCharacterSelectedElsewhere(mapping.character_id, index)"
              >
                {{ mapping.agent_character_name }}{{ isAgentCharacterAvailable(mapping) ? '' : '（Agent 未加载）' }}
              </option>
            </select>
          </label>
          <label>
            <span>服装</span>
            <select
              v-model="member.outfit"
              :disabled="store.phase === 'loading' || agentStatus === 'busy' || performanceRunning"
              @change="changeCastOutfit"
            >
              <option value="uniform">制服</option>
              <option value="race_outfit">决胜服</option>
            </select>
          </label>
          <span class="mapping-preview">
            {{ mappingFor(member.characterId)?.character_id }} → {{ mappingFor(member.characterId)?.stage_actor_id }}
          </span>
          <button
            class="cast-remove"
            type="button"
            :disabled="selectedCast.length <= 1 || store.phase === 'loading' || agentStatus === 'busy' || performanceRunning"
            @click="removeCastMember(index)"
          >
            移除
          </button>
        </article>
      </div>
    </section>

    <section class="workspace">
      <div class="stage-card">
        <div class="stage-meta">
          <div>
            <span class="meta-label">PLAYABLE SLICE</span>
            <strong>角色加载 · 碰撞寻路 · Agent Stage Actions · Portal</strong>
          </div>
          <div class="key-guide" aria-label="移动操作">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            <span>移动训练员</span>
          </div>
        </div>
        <div ref="stageElement" class="stage-mount" :aria-label="`${stageName}舞台`">
          <div v-if="store.phase === 'loading'" class="loading-panel">LOADING STAGE…</div>
          <div v-if="store.phase === 'error'" class="error-panel">
            <strong>装载失败</strong>
            <span>{{ store.error }}</span>
            <button type="button" @click="() => initialize()">重试</button>
          </div>
        </div>
        <div class="action-dock">
          <button class="primary-action" :disabled="store.phase !== 'ready' || performanceRunning" type="button" @click="runPerformanceDemo">
            <span>▶</span> {{ performanceRunning ? '正在演出兼容 JSON 短剧…' : '运行兼容 JSON 短剧' }}
          </button>
          <div class="camera-actions" aria-label="镜头控制">
            <span>CAMERA</span>
            <button :disabled="store.phase !== 'ready' || !currentPlayerActorId || performanceRunning" type="button" @click="followCamera(currentPlayerActorId)">镜头跟随训练员</button>
            <button :disabled="store.phase !== 'ready' || !activeActorId || performanceRunning" type="button" @click="followCamera(activeActorId)">镜头跟随{{ activeCharacterName }}</button>
            <button :disabled="store.phase !== 'ready' || performanceRunning" type="button" @click="showCameraOverview">场景总览</button>
            <button v-for="zone in sceneZones.slice(0, 2)" :key="`camera-zone-${zone.id}`" :disabled="store.phase !== 'ready' || performanceRunning" type="button" @click="focusCameraOnZone(zone.id)">
              定镜 · {{ zone.displayName }}
            </button>
            <button v-if="sceneZones.length === 0 && sceneAnchors[0]" :disabled="store.phase !== 'ready' || performanceRunning" type="button" @click="focusCameraOnAnchor(sceneAnchors[0].id)">
              定镜 · {{ sceneAnchors[0].displayName }}
            </button>
          </div>
          <div class="actor-actions" aria-label="角色跟随控制">
            <span>ACTOR</span>
            <button :disabled="store.phase !== 'ready' || !currentPlayerActorId || !activeActorId || activeActorFollowsPlayer || performanceRunning" type="button" @click="startActorFollow">
              {{ activeCharacterName }}跟随训练员
            </button>
            <button :disabled="store.phase !== 'ready' || !activeActorFollowsPlayer || performanceRunning" type="button" @click="stopActorFollow">
              {{ activeCharacterName }}停止跟随
            </button>
          </div>
          <div class="environment-actions" aria-label="环境控制">
            <span>ENV</span>
            <label>
              <span>时间</span>
              <select v-model="stageEnvironment.time_of_day" :disabled="store.phase !== 'ready' || performanceRunning" aria-label="时间" @change="applyStageEnvironment">
                <option value="day">白天</option>
                <option value="evening">黄昏</option>
                <option value="night">夜晚</option>
              </select>
            </label>
            <label>
              <span>天气</span>
              <select v-model="stageEnvironment.weather" :disabled="store.phase !== 'ready' || performanceRunning" aria-label="天气" @change="applyStageEnvironment">
                <option value="clear">晴朗</option>
                <option value="rain">雨</option>
                <option value="snow">雪</option>
              </select>
            </label>
            <label v-if="stageEnvironment.weather !== 'clear'" class="environment-intensity">
              <span>强度</span>
              <input v-model.number="stageEnvironment.intensity" type="range" min="0.15" max="1" step="0.05" aria-label="天气强度" :disabled="store.phase !== 'ready' || performanceRunning" @change="applyStageEnvironment">
            </label>
          </div>
          <button v-if="currentSceneId === 'tracen_student_plaza'" :disabled="store.phase !== 'ready' || !activeActorId || performanceRunning" type="button" @click="runMeeting">
            <span>▶</span> 运行会面演出
          </button>
          <button v-for="anchor in sceneAnchors.slice(0, 3)" :key="anchor.id" :disabled="store.phase !== 'ready' || !activeActorId || performanceRunning" type="button" @click="sendActorTo(anchor.id, anchor.displayName)">
            {{ anchor.displayName }}
          </button>
          <button v-for="path in activityPaths" :key="path.id" :disabled="store.phase !== 'ready' || !activeActorId || performanceRunning" type="button" @click="runActivityPath(path.id, path.activityId)">
            执行 {{ path.activityId }}
          </button>
          <button :disabled="performanceRunning" type="button" @click="resetCurrentScene">重置场景</button>
          <div class="scene-actions" aria-label="地图切换">
            <span>MAP</span>
            <select :value="activeStagePath" :disabled="store.phase !== 'ready' || performanceRunning" aria-label="地图" @change="changeStageFromSelect">
              <option v-for="choice in stageChoices" :key="choice.stage_id" :value="choice.definition_path">
                {{ choice.display_name }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <aside class="inspector">
        <section class="panel agent-panel">
          <div class="panel-heading">
            <span class="eyebrow">TRAINER ↔ ACTOR</span>
            <span class="agent-dot" :class="agentStatus"></span>
          </div>
          <div class="agent-session-summary">
            <strong>训练员 ↔ {{ castCharacterNames || '出演角色' }}</strong>
            <span>多人 Stage Director · 会话由 .env 自动初始化</span>
          </div>
          <div class="agent-status-row">
            <p class="agent-message">{{ agentStatusMessage }}</p>
            <button v-if="agentStatus === 'error' || agentStatus === 'disconnected'" type="button" @click="prepareAgentSession">重试</button>
          </div>
          <ol class="conversation-list">
            <li v-for="line in conversation" :key="line.id" :class="line.kind">
              <strong>{{ line.speaker }}</strong>
              <span>{{ line.text }}</span>
            </li>
            <li v-if="conversation.length === 0" class="conversation-empty">
              输入一句话，测试多角色发言调度、对白与舞台行为响应。
            </li>
          </ol>
          <form class="agent-compose" @submit.prevent="sendAgentMessage">
            <textarea v-model="agentInput" rows="2" :disabled="agentStatus === 'busy' || performanceRunning" placeholder="例如：我们去喷泉旁聊聊吧。" @keydown.enter.exact.prevent="sendAgentMessage"></textarea>
            <button type="submit" :disabled="!agentInput.trim() || agentStatus === 'busy' || performanceRunning">发送</button>
          </form>
        </section>

        <section class="panel actors-panel">
          <div class="panel-heading">
            <span class="eyebrow">LIVE ACTORS</span>
            <span class="count">{{ actorViews.length }} / {{ resolvedCast.length + (currentPlayerActorId ? 1 : 0) }}</span>
          </div>
          <article v-for="view in actorViews" :key="view.instanceId" class="actor-row" :class="{ active: !view.player && view.instanceId === activeActorId }">
            <div class="actor-index" :class="view.player ? 'trainer-index' : 'vega-index'">{{ view.initials }}</div>
            <div>
              <strong>{{ view.displayName }}</strong>
              <small>{{ actor(view.instanceId)?.control_owner ?? '—' }} · {{ actor(view.instanceId)?.locomotion ?? '—' }}/{{ actor(view.instanceId)?.facing ?? '—' }}</small>
            </div>
            <div class="actor-row-tail">
              <span class="coordinate">{{ actor(view.instanceId) ? `${Math.round(actor(view.instanceId)!.position.x)}, ${Math.round(actor(view.instanceId)!.position.y)}` : '—' }}</span>
              <button v-if="!view.player" type="button" @click="selectActiveActor(view.instanceId)">
                {{ view.instanceId === activeActorId ? '当前' : '选择' }}
              </button>
            </div>
          </article>
        </section>

        <section class="panel event-panel">
          <div class="panel-heading">
            <span class="eyebrow">STAGE EVENTS</span>
            <span class="live-mark">LIVE</span>
          </div>
          <ol class="event-list">
            <li v-for="event in [...store.events].reverse()" :key="event.sequence" :class="event.type.split('.')[0]">
              <span>{{ formatEvent(event) }}</span>
              <time>{{ (event.time_ms / 1000).toFixed(1) }}s</time>
            </li>
            <li v-if="store.events.length === 0" class="empty-event">等待舞台事件…</li>
          </ol>
        </section>
      </aside>
    </section>
  </main>
</template>
