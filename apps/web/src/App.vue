<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";

import {
  animeStageScriptSchema,
  characterAgentMappingSchema,
  characterPackSchema,
  characterRegistrySchema,
  performanceScriptSchema,
  scenePackSchema,
  stageEnvironmentSchema,
  stageDefinitionSchema,
  stageRegistrySchema,
  type CameraCue,
  type CharacterAgentMapping,
  type CharacterAgentMappingEntry,
  type CharacterPack,
  type CharacterRegistry,
  type AgentStageAction,
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
  compileAnimeStageScript,
  compilePerformanceCue,
  StageRuntime,
  ShowRunner,
  validatePerformanceScene,
  WorldPresence,
  type CommandResult,
  type StageCastOutfit,
  type ShowContext,
  type ShowState,
} from "@uma-stage/core";

import AppHeader from "./components/AppHeader.vue";
import CastPanel from "./components/CastPanel.vue";
import ConversationPanel from "./components/ConversationPanel.vue";
import StageControls from "./components/StageControls.vue";
import StageDiagnostics from "./components/StageDiagnostics.vue";
import StageViewport from "./components/StageViewport.vue";
import { useAgentStage } from "./composables/useAgentStage";
import { PerformanceAudioPlayer, performanceAudioPaths } from "./performance-audio";
import { assembleSceneActors } from "./scene-actors";
import { useStageStore } from "./stores/stage";
import { resolveStageShortcut } from "./stage-shortcuts";
import WorldOverview from "./WorldOverview.vue";
import { loadWorldOverview, type WorldOverviewData } from "./world-overview";
import { travelActorToScene, type WorldTravelHost } from "./world-travel";

type RendererModule = typeof import("@uma-stage/renderer-phaser");
type StageGame = ReturnType<RendererModule["createStageGame"]>;

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

interface FollowBinding {
  actorId: string;
  targetActorId: string;
  distanceTiles: number;
}

interface StageInitializationOptions {
  signal?: AbortSignal;
  definitionPath?: string;
  spawnOverrides?: Record<string, string>;
  followBindings?: FollowBinding[];
  resetWorld?: boolean;
  skipPresenceSync?: boolean;
  preserveAgentOperation?: boolean;
}

const stageConfig = __STAGE_CONFIG__;
const agentEnabled = stageConfig.mode === "agent";

const stageViewport = ref<InstanceType<typeof StageViewport> | null>(null);
const store = useStageStore();
const stageName = ref("特雷森学生广场");
const stageTransitionImage = ref("");
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

const performanceRunning = ref(false);
const showState = ref<ShowState>({ status: "idle", sceneId: null, beatId: null, error: null });
const performancePaused = computed(() => showState.value.status === "paused");
const stageEnvironment = ref<StageEnvironment>(stageEnvironmentSchema.parse({}));
const minimapVisible = ref(true);
const mapOverviewActive = ref(false);
const worldOverviewOpen = ref(false);
const worldOverviewData = shallowRef<WorldOverviewData | null>(null);
const worldOverviewLoading = ref(false);
const worldOverviewError = ref("");
const worldTravelRunning = ref(false);
let worldOverviewPromise: Promise<WorldOverviewData> | null = null;

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
const worldPresenceRevision = ref(0);
const castLocations = computed(() => {
  worldPresenceRevision.value;
  return Object.fromEntries(
    resolvedCast.value.map((member) => {
      const actorId = member.mapping.stage_actor_id;
      const sceneId = worldPresence.actor(actorId)?.scene_id ?? "";
      const sceneName = stageChoices.value.find((choice) => choice.scene_id === sceneId)?.display_name ?? sceneId;
      const prefix = actorId === activeActorId.value
        ? "当前互动"
        : sceneId === currentSceneId.value ? "当前地图" : "留守";
      return [actorId, { sceneId, label: `${prefix} · ${sceneName || "未知地点"}` }];
    }),
  );
});
const activeActorFollowsPlayer = computed(
  () => actor(activeActorId.value)?.following_actor_id === currentPlayerActorId.value,
);
const canControlActiveActor = computed(() =>
  store.phase === "ready" && !performanceRunning.value && Boolean(currentPlayerActorId.value) && Boolean(actor(activeActorId.value)),
);

let runtime: StageRuntime | null = null;
let game: StageGame | null = null;
let characterRegistry: CharacterRegistry | null = null;
let unsubscribe: (() => void) | null = null;
let snapshotTimer: number | null = null;
let generation = 0;
let commandSequence = 0;
let portalTransitionPending = false;
let portalTransitionTimer: number | null = null;
let runPortalTransition: (() => void) | null = null;
let cameraCueBeforeOverview: CameraCue | null = null;
const performanceAudio = new PerformanceAudioPlayer(contentUrl);
const showRunner = new ShowRunner((state) => { showState.value = state; });
let unmounted = false;
const worldPresence = new WorldPresence();
const {
  agentStatus,
  agentStatusMessage,
  agentCharacters,
  agentMaxParticipants,
  agentInput,
  conversation,
  canRetryTurn,
  prepareAgentSession,
  sendAgentMessage,
  cancelAgentTurn,
  invalidateAgent,
  resetAgentSession,
  retryAgentSession,
  pushConversation,
} = useAgentStage({
  enabled: agentEnabled,
  baseUrl: stageConfig.agentUrl,
  apiKey: stageConfig.agentApiKey,
  adapter: {
    getCast: () => resolveCast().map((member) => ({
      characterId: member.mapping.character_id,
      displayName: member.mapping.agent_character_name,
      stageActorId: member.mapping.stage_actor_id,
    })),
    getStage: () => {
      const activeRuntime = runtime;
      if (!activeRuntime) return null;
      return {
        runtime: activeRuntime,
        stageId: currentStageId.value,
        sceneId: currentSceneId.value,
        sceneName: stageName.value,
      };
    },
    getActorScene: (actorId) => worldPresence.actor(actorId)?.scene_id ?? null,
    getRemoteActors: () => resolvedCast.value.flatMap((member) => {
      const actorId = member.mapping.stage_actor_id;
      const presence = worldPresence.actor(actorId);
      return presence && presence.scene_id !== currentSceneId.value
        ? [{ stageActorId: actorId, sceneId: presence.scene_id }]
        : [];
    }),
    getTravelDestinations: async () => {
      const data = await ensureWorldOverviewData();
      return stageChoices.value.flatMap((choice) => {
        const scene = data.scenes.get(choice.scene_id);
        return scene ? [{
          sceneId: choice.scene_id,
          displayName: choice.display_name,
          spawnIds: scene.spawns.map((spawn) => spawn.id),
        }] : [];
      });
    },
    executeTravel: (action, signal) => executeDirectorTravel(action, signal),
    nextCommandId: () => nextCommandId("agent"),
  },
});
const maxCast = computed(() => agentEnabled ? agentMaxParticipants.value : 4);
const PORTAL_TRANSITION_FALLBACK_MS = 750;
const PORTAL_TRANSITION_AFTER_COMMAND_MS = 50;

onMounted(() => {
  window.addEventListener("keydown", handleStageShortcut);
  document.addEventListener("visibilitychange", handleShowVisibility);
  void initializeApplication();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleStageShortcut);
  document.removeEventListener("visibilitychange", handleShowVisibility);
  unmounted = true;
  showRunner.cancel("页面已关闭");
  void performanceAudio.dispose();
  dispose();
});

async function initializeApplication(): Promise<void> {
  await initialize();
  if (store.phase !== "ready" || !agentEnabled) return;
  await prepareAgentSession();
}

async function initialize(options: StageInitializationOptions = {}): Promise<void> {
  if (!options.skipPresenceSync && runtime) {
    worldPresence.syncScene(runtime.scene, runtime.snapshot());
  }
  const currentGeneration = ++generation;
  dispose(false, options.preserveAgentOperation ?? false);
  portalTransitionPending = false;
  store.reset();
  actorViews.value = [];
  try {
    const [registry, stageRegistry, mapping] = await Promise.all([
      loadCharacterRegistry(contentUrl("characters/registry.json")),
      loadStageRegistry(contentUrl("stages/registry.json")),
      loadCharacterMapping(contentUrl("characters/agent-mapping.json")),
    ]);
    if (currentGeneration !== generation || options.signal?.aborted) return;
    characterRegistry = registry;
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
    if (currentGeneration !== generation || options.signal?.aborted) return;
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
    if (currentGeneration !== generation || options.signal?.aborted) return;
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
    if (currentGeneration !== generation || options.signal?.aborted) return;

    const { scene, runtime: nextRuntime, playerActorId } = assembleSceneActors({
      sourceScene,
      stage,
      presences: worldPresence,
      packs,
      ...(options.spawnOverrides ? { spawnOverrides: options.spawnOverrides } : {}),
      ...(options.followBindings ? { followBindings: options.followBindings } : {}),
      nextCommandId,
    });
    const rendererActors = stage.actors.map((actorDefinition, index) => {
      const pack = packs[index];
      if (!pack) throw new Error(`缺少角色包：${actorDefinition.bundle_id}`);
      const registryEntry = registryByBundle.get(actorDefinition.bundle_id);
      if (!registryEntry) throw new Error(`缺少角色注册项：${actorDefinition.bundle_id}`);
      return {
        actorId: actorDefinition.instance_id,
        pack,
        bundleBaseUrl: contentDirectoryUrl(registryEntry.actor_path),
      };
    });
    runtime = nextRuntime;
    unsubscribe = nextRuntime.subscribe((event) => {
      if (event.type === "actor.despawned") {
        actorViews.value = actorViews.value.filter((view) => view.instanceId !== event.actor_id);
        if (activeActorId.value === event.actor_id) {
          activeActorId.value = nextRuntime.snapshot().actors.find((state) => state.control_owner !== "player")?.actor_id ?? "";
        }
        store.setSnapshot(nextRuntime.snapshot());
        const cue = game?.cameraState()?.cue;
        if (cue?.type === "camera.follow_actor" && cue.actor_id === event.actor_id && playerActorId) {
          followCamera(playerActorId);
        }
      }
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

    const parent = stageViewport.value?.getMountElement();
    if (!parent) throw new Error("舞台挂载点不存在");
    const nextGame = renderer.createStageGame({
      parent,
      runtime: nextRuntime,
      scene,
      sceneBaseUrl: contentDirectoryUrl(castStage.scene_path),
      ...(playerActorId === undefined ? {} : { playerActorId }),
      actors: rendererActors,
      environment: stageEnvironment.value,
      sceneNames: Object.fromEntries(stageRegistry.stages.map((entry) => [entry.scene_id, entry.display_name])),
    });
    game = nextGame;
    nextGame.setMinimapVisible(minimapVisible.value);
    syncPlayerInput();
    nextGame.setPlaybackPaused(performancePaused.value);
    await nextGame.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (currentGeneration !== generation || options.signal?.aborted || game !== nextGame) return;
    mapOverviewActive.value = false;
    cameraCueBeforeOverview = null;
    snapshotTimer = window.setInterval(() => {
      if (runtime) store.setSnapshot(runtime.snapshot());
    }, 100);
    worldPresence.syncScene(scene, nextRuntime.snapshot());
    store.ready();
    stageTransitionImage.value = "";
  } catch (error) {
    if (currentGeneration === generation && !options.signal?.aborted) store.fail(error);
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

function dispose(invalidate = true, preserveAgentOperation = false): void {
  if (invalidate) generation += 1;
  if (!preserveAgentOperation) invalidateAgent("舞台已销毁");
  if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
  snapshotTimer = null;
  if (portalTransitionTimer !== null) window.clearTimeout(portalTransitionTimer);
  portalTransitionTimer = null;
  runPortalTransition = null;
  unsubscribe?.();
  unsubscribe = null;
  const transitionFrame = game?.captureFrame();
  if (transitionFrame) stageTransitionImage.value = transitionFrame;
  game?.destroy();
  game = null;
  runtime?.dispose("舞台已切换");
  runtime = null;
  mapOverviewActive.value = false;
  cameraCueBeforeOverview = null;
}

async function changeCast(castIndex?: number): Promise<void> {
  normalizeSelectedCast(characterMappings.value);
  if (castIndex !== undefined) {
    const selected = selectedCast.value[castIndex];
    const mapping = selected && mappingFor(selected.characterId);
    if (mapping) activeActorId.value = mapping.stage_actor_id;
  }
  resetAgentSession(false);
  conversation.value = [];
  await initialize({ definitionPath: activeStagePath.value });
  if (store.phase === "ready" && agentEnabled) await prepareAgentSession();
}

async function runPerformanceDemo(): Promise<void> {
  if (performanceRunning.value) return;
  performanceRunning.value = true;
  game?.setPlayerInputEnabled(false);
  let ownsStage = false;
  let title = "JSON 短剧";
  const result = await showRunner.run(async (context) => {
    // Start unlocking while the run-button user gesture is still available.
    await context.guard(performanceAudio.unlock());
    return loadPerformance(contentUrl("performances/admire-vega-starlight.anime.json"), context.signal);
  }, {
    prepare: async (script, context) => {
      title = script.title;
      const characterCast = script.cast.filter((member) => member.character_id !== "trainer");
      if (characterCast.length === 0 || characterCast.length > 4) {
        throw new Error(`当前 Stage 支持 1–4 位角色，剧本声明了 ${characterCast.length} 位`);
      }
      performanceRoleBindings(script, "trainer");
      const cast = characterCast.map((member) => ({ characterId: member.character_id, outfit: performanceOutfit(member.outfit_id) }));
      for (const performanceScene of script.scenes) {
        const stage = stageChoices.value.find((choice) => choice.stage_id === performanceScene.stage_id);
        if (!stage) throw new Error(`剧本引用了未知舞台：${performanceScene.stage_id}`);
        const definition = stageDefinitionSchema.parse(await context.guard(fetchJson(contentUrl(stage.definition_path), context.signal)));
        const scene = scenePackSchema.parse(await context.guard(fetchJson(contentUrl(definition.scene_path), context.signal)));
        validatePerformanceScene(performanceScene, scene);
      }
      await context.guard(performanceAudio.preload(performanceAudioPaths(script), context.signal));
      selectedCast.value = cast;
      ownsStage = true;
      resetAgentSession(false);
      conversation.value = [];
      activeActorId.value = resolveCast()[0]?.mapping.stage_actor_id ?? "";
      pushConversation("system", "演出", `开始《${script.title}》`);
    },
    enterScene: async (script, performanceScene, context) => {
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
        signal: context.signal,
      });
      await context.checkpoint();
      if (store.phase !== "ready" || !runtime) {
        throw new Error(store.error || `无法装载剧本舞台：${stage.display_name}`);
      }
      const bindings = performanceRoleBindings(script, currentPlayerActorId.value);
      for (const actorId of Object.values(bindings)) runtime.setControlOwner(actorId, "script");
      await applyPerformancePlacements(script, performanceScene, context);
    },
    executeCue: executePerformanceCue,
    setPaused: async (paused) => {
      game?.setPlaybackPaused(paused);
      await performanceAudio.setPaused(paused);
    },
    cleanup: async () => {
      performanceAudio.stopAll();
      if (ownsStage) {
        // Invalidate any scene load that is still waiting for network/assets.
        generation += 1;
        game?.stopCameraMotion();
        restoreLiveControl();
      }
      game?.setPlaybackPaused(false);
      try { await performanceAudio.setPaused(false); }
      finally {
        if (ownsStage && !runtime && !unmounted) await initialize({ definitionPath: activeStagePath.value });
        game?.setPlaybackPaused(false);
        game?.setPlayerInputEnabled(!worldOverviewOpen.value);
      }
    },
  });
  performanceRunning.value = false;
  if (unmounted) return;
  const message = result.status === "completed" ? `《${title}》演出完成`
    : result.status === "cancelled" ? "演出已结束，已恢复自由操作"
    : `剧本演出失败：${result.error}`;
  store.setMessage(message);
  pushConversation("system", "演出", message);
}

function cancelPerformance(): void { showRunner.cancel(); }

function togglePerformancePause(): void { void showRunner.setPaused(!performancePaused.value); }

function handleShowVisibility(): void {
  if (document.hidden && performanceRunning.value) void showRunner.setPaused(true);
}

async function applyPerformancePlacements(
  script: PerformanceScript,
  scene: PerformanceScript["scenes"][number],
  context: ShowContext,
): Promise<void> {
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("舞台 Runtime 尚未就绪");
  const actorIdsByRole = performanceRoleBindings(script, currentPlayerActorId.value);
  const tasks = scene.placements.flatMap((placement) => {
    if (!placement.facing) return [];
    const actorId = actorIdsByRole[placement.role_id];
    if (!actorId) throw new Error(`剧本站位没有角色绑定：${placement.role_id}`);
    return [context.task(activeRuntime.execute({
      id: nextCommandId("placement-face"),
      type: "actor.face",
      actor_id: actorId,
      facing: placement.facing,
      source: "system",
      policy: "replace",
    }))];
  });
  await context.guard(Promise.all(tasks));
}

async function executePerformanceCue(
  script: PerformanceScript,
  cue: PerformanceCue,
  context: ShowContext,
): Promise<void> {
  await context.checkpoint();
  const activeRuntime = runtime;
  if (!activeRuntime) throw new Error("舞台 Runtime 尚未就绪");
  const actorIdsByRole = performanceRoleBindings(script, currentPlayerActorId.value);
  const compiled = compilePerformanceCue(cue, actorIdsByRole);
  if (compiled.kind === "camera") {
    if (!game) throw new Error("舞台镜头尚未就绪");
    mapOverviewActive.value = compiled.cue.type === "camera.overview";
    cameraCueBeforeOverview = null;
    await context.guard(game.playCameraCue(compiled.cue, context.signal));
    return;
  }
  if (compiled.kind === "wait") {
    await context.wait(compiled.durationMs);
    return;
  }
  if (compiled.kind === "narration") {
    pushConversation(
      "narrator",
      "环境",
      compiled.subtitleZh ?? compiled.subtitleJa ?? compiled.text,
    );
    if (compiled.audioPath) {
      const playback = await context.guard(performanceAudio.play(compiled.audioPath, context.signal));
      await context.guard(playback.completion);
    } else if (compiled.durationMs) {
      await context.wait(compiled.durationMs);
    }
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
  const playback =
    cue.type === "dialogue.say" && cue.audio_path
      ? await context.guard(performanceAudio.play(cue.audio_path, context.signal))
      : null;
  const command =
    playback && compiled.command.type === "dialogue.say"
      ? { ...compiled.command, duration_ms: playback.durationMs }
      : compiled.command;
  await context.guard(Promise.all([
    context.task(activeRuntime.execute(command)),
    playback?.completion ?? Promise.resolve(),
  ]));
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

async function changeCastOutfit(): Promise<void> {
  await initialize({ definitionPath: activeStagePath.value });
}

async function addCastMember(): Promise<void> {
  const used = new Set(selectedCast.value.map((selection) => selection.characterId));
  const mapping = characterMappings.value.find(
    (entry) => !used.has(entry.character_id) && isAgentCharacterAvailable(entry),
  );
  if (!mapping || selectedCast.value.length >= maxCast.value) return;
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
  try {
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
    if (activeRuntime !== runtime) return;
    if (result.status !== "completed") {
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
    const speechResult = await speech.completion;
    if (activeRuntime !== runtime) return;
    if (speechResult.status === "completed") store.setMessage("演出完成，可以继续操作角色");
    else describeResult(speechResult);
  } catch (error) {
    if (activeRuntime === runtime) store.setMessage(errorMessage(error));
  } finally {
    if (activeRuntime === runtime) activeRuntime.setControlOwner(actorId, "agent");
  }
}

async function sendActorTo(anchorId: string, label: string): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime) return;
  activeRuntime.setControlOwner(actorId, "agent");
  store.setMessage(`${activeCharacterName.value}前往${label}`);
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
  store.setMessage(`${activeCharacterName.value}执行 ${activityId}`);
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

async function approachTrainer(): Promise<void> {
  const activeRuntime = runtime;
  const actorId = activeActorId.value;
  if (!activeRuntime || !canControlActiveActor.value) return;
  activeRuntime.setControlOwner(actorId, "agent");
  const result = await activeRuntime.execute({
    id: nextCommandId("approach"),
    type: "actor.move_to",
    actor_id: actorId,
    target: { type: "actor", id: currentPlayerActorId.value, distance_tiles: 4, preferred_side: "above" },
    source: "agent",
    policy: "replace",
  }).completion;
  if (activeRuntime === runtime) describeResult(result, `${activeCharacterName.value}已来到训练员身边`);
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
  setStageCameraCue({
    type: "camera.follow_actor",
    actor_id: actorId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function focusCameraOnAnchor(anchorId: string): void {
  setStageCameraCue({
    type: "camera.focus_anchor",
    anchor_id: anchorId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function focusCameraOnZone(zoneId: string): void {
  setStageCameraCue({
    type: "camera.focus_zone",
    zone_id: zoneId,
    zoom: 0.8,
    transition_ms: 450,
  });
}

function setStageCameraCue(cue: CameraCue): void {
  game?.setCameraCue(cue);
  mapOverviewActive.value = cue.type === "camera.overview";
  if (cue.type !== "camera.overview") cameraCueBeforeOverview = null;
}

function toggleMapOverview(): void {
  const activeGame = game;
  if (!activeGame) return;
  if (mapOverviewActive.value) {
    const restoreCue = cameraCueBeforeOverview ?? (
      currentPlayerActorId.value
        ? {
            type: "camera.follow_actor" as const,
            actor_id: currentPlayerActorId.value,
            zoom: 0.8,
            transition_ms: 600,
          }
        : null
    );
    cameraCueBeforeOverview = null;
    mapOverviewActive.value = false;
    if (restoreCue) activeGame.setCameraCue(restoreCue);
    return;
  }
  const currentCue = activeGame.cameraState()?.cue ?? null;
  cameraCueBeforeOverview = currentCue?.type === "camera.overview" ? null : currentCue;
  mapOverviewActive.value = true;
  activeGame.setCameraCue({ type: "camera.overview", transition_ms: 600 });
}

function toggleMinimap(): void {
  minimapVisible.value = !minimapVisible.value;
  game?.setMinimapVisible(minimapVisible.value);
}

function syncPlayerInput(): void {
  game?.setPlayerInputEnabled(
    !worldOverviewOpen.value && !performanceRunning.value,
  );
}

function setWorldTraveling(active: boolean): void {
  worldTravelRunning.value = active;
  syncPlayerInput();
}

function openWorldOverview(): void {
  worldOverviewOpen.value = true;
  syncPlayerInput();
  void prepareWorldOverview();
}

function closeWorldOverview(): void {
  worldOverviewOpen.value = false;
  syncPlayerInput();
}

async function ensureWorldOverviewData(): Promise<WorldOverviewData> {
  if (worldOverviewData.value) return worldOverviewData.value;
  if (!worldOverviewPromise) {
    worldOverviewLoading.value = true;
    worldOverviewError.value = "";
    worldOverviewPromise = loadWorldOverview(
      stageChoices.value,
      (path) => fetchJson(contentUrl(path)),
    ).then((data) => {
      worldOverviewData.value = data;
      return data;
    }).catch((error: unknown) => {
      worldOverviewPromise = null;
      worldOverviewError.value = errorMessage(error);
      throw error;
    }).finally(() => {
      worldOverviewLoading.value = false;
    });
  }
  return worldOverviewPromise;
}

async function prepareWorldOverview(): Promise<void> {
  try {
    await ensureWorldOverviewData();
  } catch {
    return;
  }
}

function handleStageShortcut(event: KeyboardEvent): void {
  const shortcut = resolveStageShortcut({
    key: event.key,
    enabled: store.phase === "ready" && !performanceRunning.value && !worldOverviewOpen.value,
    editing: isTextEntryTarget(event.target),
    defaultPrevented: event.defaultPrevented,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
  });
  if (shortcut === "toggle-minimap") toggleMinimap();
  else if (shortcut === "toggle-overview") toggleMapOverview();
  else if (shortcut === "open-world") openWorldOverview();
  else return;
  event.preventDefault();
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.matches("input, textarea, select") || target.isContentEditable
  );
}

function applyStageEnvironment(): void {
  stageEnvironment.value = stageEnvironmentSchema.parse(stageEnvironment.value);
  game?.setEnvironment(stageEnvironment.value);
}

function changeStageFromSelect(definitionPath: string): void {
  if (!definitionPath || definitionPath === activeStagePath.value || agentStatus.value === "busy") return;
  void initialize({ definitionPath, resetWorld: true });
}

function resetCurrentScene(): void {
  if (agentStatus.value === "busy") return;
  void initialize({
    ...(activeStagePath.value ? { definitionPath: activeStagePath.value } : {}),
    resetWorld: true,
  });
}

async function createBackgroundRuntime(sceneId: string): Promise<StageRuntime> {
  const choice = stageChoices.value.find((candidate) => candidate.scene_id === sceneId);
  const registry = characterRegistry;
  if (!choice) throw new Error(`后台旅行找不到场景：${sceneId}`);
  if (!registry) throw new Error("后台旅行角色注册表尚未就绪");
  const sourceStage = await loadStage(contentUrl(choice.definition_path));
  const sourceScene = await loadScene(contentUrl(sourceStage.scene_path));
  const cast = resolveCast();
  const castStage = applyStageCast(
    sourceStage,
    cast.map((member) => ({ mapping: member.mapping, outfit: member.outfit })),
  );
  const presentActorIds = new Set(
    worldPresence.actorsInScene(sceneId).map((presence) => presence.actor_id),
  );
  const stage: StageDefinition = {
    ...castStage,
    actors: castStage.actors.filter((actor) => presentActorIds.has(actor.instance_id)),
  };
  if (stage.actors.length === 0) throw new Error(`后台场景没有可装载角色：${sceneId}`);
  const registryByBundle = new Map(registry.characters.map((entry) => [entry.bundle_id, entry]));
  const packs = await Promise.all(stage.actors.map((actor) => {
    const entry = registryByBundle.get(actor.bundle_id);
    if (!entry) throw new Error(`后台旅行引用了未注册角色：${actor.bundle_id}`);
    return loadActor(contentUrl(entry.actor_path));
  }));
  return assembleSceneActors({
    sourceScene,
    stage,
    presences: worldPresence,
    packs,
    nextCommandId,
  }).runtime;
}

async function executeDirectorTravel(
  action: Extract<AgentStageAction, { type: "actor.travel_to_scene" }>,
  signal: AbortSignal,
): Promise<void> {
  if (action.actor_id === currentPlayerActorId.value) {
    throw new Error("训练员请通过地图中的传送点换图");
  }
  const data = await ensureWorldOverviewData();
  const host: WorldTravelHost = {
    presence: worldPresence,
    navigation: data.navigation,
    definitionPathForScene: (sceneId) => {
      const stage = stageChoices.value.find((choice) => choice.scene_id === sceneId);
      if (!stage) throw new Error(`世界中没有可进入的场景：${sceneId}`);
      return stage.definition_path;
    },
    currentRuntime: () => runtime,
    currentSceneId: () => currentSceneId.value,
    currentGeneration: () => generation,
    playerSceneId: () => worldPresence.actor(currentPlayerActorId.value)?.scene_id ?? currentSceneId.value,
    loadScene: async (definitionPath, loadSignal, skipPresenceSync = false) => {
      await initialize({
        definitionPath,
        signal: loadSignal,
        preserveAgentOperation: true,
        skipPresenceSync,
      });
      if (loadSignal.aborted) throw new DOMException("跨图场景装载已取消", "AbortError");
      if (store.phase !== "ready" || !runtime) {
        throw new Error(store.error || "旅行场景装载失败");
      }
      return runtime;
    },
    createBackgroundRuntime: (sceneId) => createBackgroundRuntime(sceneId),
    syncActor: (travelRuntime, actorId) => {
      const state = travelRuntime.snapshot().actors.find((actor) => actor.actor_id === actorId);
      if (!state) throw new Error(`后台旅行同步时缺少角色：${actorId}`);
      worldPresence.syncActor(travelRuntime.scene, state);
      worldPresenceRevision.value += 1;
    },
    setTraveling: setWorldTraveling,
    report: (message) => store.setMessage(message),
    actorName: (actorId) => resolvedCast.value.find(
      (member) => member.mapping.stage_actor_id === actorId,
    )?.mapping.agent_character_name ?? actorId,
    sceneName: (sceneId) => stageChoices.value.find(
      (choice) => choice.scene_id === sceneId,
    )?.display_name ?? sceneId,
  };
  await travelActorToScene(host, action, signal);
  store.setMessage(`${host.actorName(action.actor_id)}已到达${host.sceneName(action.target_scene_id)}`);
}

function isAgentCharacterAvailable(mapping: CharacterAgentMappingEntry): boolean {
  return !agentEnabled || agentCharacters.value.length === 0 || agentCharacters.value.includes(mapping.agent_character_name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function loadPerformance(url: string, signal?: AbortSignal): Promise<PerformanceScript> {
  const payload = await fetchJson(url, signal);
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

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`无法读取 ${url} (${response.status})`);
  return response.json() as Promise<unknown>;
}

function updateCastCharacter(index: number, characterId: string): void {
  const member = selectedCast.value[index];
  if (!member || member.characterId === characterId) return;
  member.characterId = characterId;
  void changeCast(index);
}

function updateCastOutfitSelection(index: number, outfit: StageCastOutfit): void {
  const member = selectedCast.value[index];
  if (!member || member.outfit === outfit) return;
  member.outfit = outfit;
  void changeCastOutfit();
}

function updateStageEnvironment(patch: Partial<StageEnvironment>): void {
  stageEnvironment.value = stageEnvironmentSchema.parse({ ...stageEnvironment.value, ...patch });
  applyStageEnvironment();
}

</script>

<template>
  <main class="shell">
    <AppHeader
      :stage-name="stageName"
      :phase="store.phase"
      :message="store.message"
      :agent-enabled="agentEnabled"
      :agent-status="agentStatus"
    />
    <div class="workspace">
      <CastPanel
        :selections="selectedCast"
        :mappings="characterMappings"
        :actor-locations="castLocations"
        :active-actor-id="activeActorId"
        :active-character-name="activeCharacterName"
        :agent-characters="agentCharacters"
        :agent-enabled="agentEnabled"
        :agent-status="agentStatus"
        :max-cast="maxCast"
        :ready="store.phase === 'ready'"
        :performance-running="performanceRunning"
        :active-actor-follows-player="activeActorFollowsPlayer"
        :can-control-active-actor="canControlActiveActor"
        @select="selectActiveActor"
        @add="addCastMember"
        @remove="removeCastMember"
        @update-character="updateCastCharacter"
        @update-outfit="updateCastOutfitSelection"
        @approach="approachTrainer"
        @follow="startActorFollow"
        @stop-follow="stopActorFollow"
      />
      <div class="stage-workspace">
        <StageViewport
          ref="stageViewport"
          :stage-name="stageName"
          :phase="store.phase"
          :message="store.message"
          :error="store.error"
          :transition-image="stageTransitionImage"
          @retry="() => initialize()"
        />
        <StageControls
          :ready="store.phase === 'ready'"
          :busy="agentStatus === 'busy'"
          :stage-choices="stageChoices"
          :active-stage-path="activeStagePath"
          :current-scene-id="currentSceneId"
          :current-player-actor-id="currentPlayerActorId"
          :active-actor-id="activeActorId"
          :active-character-name="activeCharacterName"
          :scene-anchors="sceneAnchors"
          :scene-zones="sceneZones"
          :activity-paths="activityPaths"
          :environment="stageEnvironment"
          :minimap-visible="minimapVisible"
          :map-overview-active="mapOverviewActive"
          :performance-running="performanceRunning"
          :performance-paused="performancePaused"
          :performance-status="showState.status"
          :performance-beat-id="showState.beatId"
          @change-stage="changeStageFromSelect"
          @open-world="openWorldOverview"
          @toggle-minimap="toggleMinimap"
          @toggle-overview="toggleMapOverview"
          @follow-camera="followCamera"
          @focus-zone="focusCameraOnZone"
          @focus-anchor="focusCameraOnAnchor"
          @send-actor-to="sendActorTo"
          @run-activity="runActivityPath"
          @run-meeting="runMeeting"
          @update-environment="updateStageEnvironment"
          @run-performance="runPerformanceDemo"
          @toggle-performance-pause="togglePerformancePause"
          @cancel-performance="cancelPerformance"
          @reset="resetCurrentScene"
        />
      </div>
      <aside class="inspector">
        <ConversationPanel
          v-model="agentInput"
          :agent-enabled="agentEnabled"
          :agent-status="agentStatus"
          :agent-status-message="agentStatusMessage"
          :conversation="conversation"
          :cast-names="castCharacterNames"
          :performance-running="performanceRunning"
          :can-retry-turn="canRetryTurn"
          @send="sendAgentMessage"
          @retry="retryAgentSession"
          @cancel="cancelAgentTurn"
        />
        <StageDiagnostics
          :actors="actorViews"
          :actor-states="store.snapshot?.actors ?? []"
          :events="store.events"
          :conversation="conversation"
        />
      </aside>
    </div>
    <WorldOverview
      v-if="worldOverviewOpen"
      :data="worldOverviewData"
      :current-scene-id="currentSceneId"
      :loading="worldOverviewLoading"
      :error="worldOverviewError"
      @close="closeWorldOverview"
      @retry="prepareWorldOverview"
    />
  </main>
</template>
