import type { CharacterPack, ScenePack } from "@uma-stage/contracts";
import { StageRuntime } from "@uma-stage/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAgentStage, type AgentStageAdapter, type AgentStageFrame } from "./useAgentStage";

const displayName = "爱慕织姬";
const stageActorId = "uma_admire_vega";
const agentActorId = "agent_admire_vega";
const requiredStageActions = [
  "actor.move_to",
  "actor.approach",
  "actor.follow",
  "actor.stop_follow",
  "actor.stop",
  "actor.face",
  "actor.face_actor",
  "dialogue.say",
] as const;

const pack: CharacterPack = {
  schema_version: 1,
  actor_id: "agent_test_pack",
  display_name: displayName,
  outfit_id: "default",
  atlas: { image: "atlas.png", data: "atlas.json" },
  render: { frame_width: 64, frame_height: 64, anchor_x: 32, anchor_y: 61, scale: 1 },
  movement: { speed_px_per_second: 128, idle_after_ms: 500 },
  default_direction: "down",
  animations: {
    stand: {
      fps: 1, loop: false, fallback: null,
      directions: { down: ["d"], left: ["l"], right: ["r"], up: ["u"] },
    },
    walk: { fps: 8, loop: true, directions: {}, fallback: "stand" },
    idle: { fps: 4, loop: true, directions: {}, fallback: "stand" },
  },
};

const scene: ScenePack = {
  schema_version: "scene_pack.v1",
  scene_id: "agent_runtime_test",
  display_name: "Agent Runtime Test",
  description: "",
  map: { tile_size: 32, width: 6, height: 5, background_color: "#000000" },
  layers: [], landmarks: [],
  navigation: { blocked_tiles: [] },
  zones: [], surfaces: [], props: [], portals: [], activity_paths: [],
  spawns: [{ id: "entry", position: { x: 0, y: 0 }, facing: "right" }],
  anchors: [
    {
      id: "near", display_name: "Near", description: "", position: { x: 2, y: 0 },
      tags: [], interactions: [], slots: [],
    },
    {
      id: "far", display_name: "Far", description: "", position: { x: 5, y: 4 },
      tags: [], interactions: [], slots: [],
    },
  ],
};

interface TurnRequest {
  session_id: string;
  user_uuid: string;
  events: Array<{ content: string; target_actor_ids: string[] }>;
  actor_bindings: Array<{
    agent_actor_id: string;
    stage_actor_id: string;
    scene_id?: string;
  }>;
  live_stage: {
    actors: Array<{ actor_id: string }>;
    remote_actors: Array<{ actor_id: string; scene_id: string }>;
    travel_destinations: Array<{ scene_id: string; display_name: string; spawn_ids: string[] }>;
  };
}

interface HarnessActor {
  characterId: string;
  displayName: string;
  stageActorId: string;
  agentActorId: string;
  present: boolean;
  sceneId: string;
}

interface AgentHarnessOptions {
  supportsTravel?: boolean;
  actors?: HarnessActor[];
  includeTrainer?: boolean;
  destinations?: Array<{ sceneId: string; displayName: string; spawnIds: string[] }>;
}

type TurnHandler = (request: TurnRequest, turnNumber: number) => Response | Promise<Response>;

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

function turnPayload(sessionId: string, events: unknown[] = [], stageActions: unknown[] = []) {
  return {
    schema_version: "agent_stage_turn.v1",
    session_id: sessionId,
    turn_index: 1,
    events,
    stage_actions: stageActions,
    scene_state: {},
  };
}

function characterReply() {
  return {
    event_id: "reply-1",
    sequence: 1,
    event_type: "character_reply",
    content: "你好，训练员。",
    dialogue: "你好，训练员。",
    action: "轻轻挥手",
    actor: { actor_id: agentActorId, display_name: displayName },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createAgentHarness(
  turnHandler: TurnHandler = (request) => jsonResponse(turnPayload(request.session_id)),
  options: AgentHarnessOptions = {},
) {
  const actors: HarnessActor[] = options.actors ?? [{
    characterId: "admire_vega",
    displayName,
    stageActorId,
    agentActorId,
    present: true,
    sceneId: scene.scene_id,
  }];
  const cast = actors.map((actor) => ({
    characterId: actor.characterId,
    displayName: actor.displayName,
    stageActorId: actor.stageActorId,
  }));
  const spawns = [...scene.spawns];
  const extraSpawnPositions = [
    { x: 1, y: 0 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 4 },
    { x: 5, y: 3 },
  ];
  const spawnCount = actors.length + (options.includeTrainer ? 1 : 0);
  for (let index = 1; index < spawnCount; index += 1) {
    spawns.push({
      id: `spawn-${index}`,
      position: extraSpawnPositions[index - 1] ?? { x: index % scene.map.width, y: 2 },
      facing: "right",
    });
  }
  const runtime = new StageRuntime({ ...scene, spawns });
  const spawnIds = new Map<string, string>();
  actors.forEach((actor, index) => {
    const spawnId = index === 0 ? "entry" : `spawn-${index}`;
    spawnIds.set(actor.stageActorId, spawnId);
    if (!actor.present) return;
    runtime.spawnActor({
      actorId: actor.stageActorId,
      characterPack: pack,
      spawnId,
      controlOwner: "script",
    });
  });
  if (options.includeTrainer) {
    const trainerSpawnId = actors.length === 0 ? "entry" : `spawn-${actors.length}`;
    spawnIds.set("trainer", trainerSpawnId);
    runtime.spawnActor({
      actorId: "trainer",
      characterPack: pack,
      spawnId: trainerSpawnId,
      controlOwner: "player",
    });
  }
  const actorScenes = new Map<string, string>(
    actors.map((actor) => [actor.stageActorId, actor.sceneId]),
  );
  if (options.includeTrainer) actorScenes.set("trainer", scene.scene_id);
  let currentStage: AgentStageFrame = {
    runtime,
    stageId: "agent_test_stage",
    sceneId: scene.scene_id,
    sceneName: scene.display_name,
  };
  let travelHandler: AgentStageAdapter["executeTravel"] = async () => {};
  const destinations = options.destinations ?? [];
  const sessionRequests: Array<Record<string, unknown>> = [];
  const turnRequests: TurnRequest[] = [];
  const turnSignals: Array<AbortSignal | null | undefined> = [];
  const issuedCommandIds: string[] = [];
  let sessionSequence = 0;
  let commandSequence = 0;

  const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/characters") {
      return Promise.resolve(jsonResponse({ characters: actors.map((actor) => actor.displayName) }));
    }
    if (path === "/stage/capabilities") {
      return Promise.resolve(jsonResponse({
        schema_version: "agent_stage_api.v1",
        session_api: 1,
        turn_schema_version: "agent_stage_turn.v1",
        action_types: [
          ...requiredStageActions,
          ...(options.supportsTravel ? ["actor.travel_to_scene"] : []),
        ],
        max_stage_actions_per_turn: 8,
      }));
    }
    if (path === "/capabilities") {
      return Promise.resolve(jsonResponse({ director_max_participants: 3 }));
    }
    if (path === "/stage/sessions") {
      sessionSequence += 1;
      sessionRequests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Promise.resolve(jsonResponse({
        session_id: `session-${sessionSequence}`,
        user_uuid: `user-${sessionSequence}`,
        participants: actors.map((actor) => ({
          actor: {
            actor_id: actor.agentActorId,
            actor_type: "umamusume",
            display_name: actor.displayName,
          },
        })),
      }));
    }
    if (path === "/stage/turn") {
      const request = JSON.parse(String(init?.body ?? "{}")) as TurnRequest;
      turnRequests.push(request);
      turnSignals.push(init?.signal);
      return turnHandler(request, turnRequests.length);
    }
    throw new Error(`Unexpected Agent request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const executeTravel = vi.fn<AgentStageAdapter["executeTravel"]>(
    (action, signal) => travelHandler(action, signal),
  );
  const getActorScene = vi.fn((actorId: string) => actorScenes.get(actorId) ?? null);
  const getRemoteActors = vi.fn(() => actors.flatMap((actor) => {
    const actorScene = actorScenes.get(actor.stageActorId);
    return actorScene && actorScene !== currentStage.sceneId
      ? [{ stageActorId: actor.stageActorId, sceneId: actorScene }]
      : [];
  }));
  const getTravelDestinations = vi.fn(async () => destinations);
  const adapter: AgentStageAdapter = {
    getCast: () => cast,
    getStage: () => currentStage,
    executeTravel,
    getActorScene,
    getRemoteActors,
    getTravelDestinations,
    nextCommandId: () => {
      commandSequence += 1;
      const commandId = `command-${commandSequence}`;
      issuedCommandIds.push(commandId);
      return commandId;
    },
  };
  const agent = useAgentStage({
    enabled: true,
    baseUrl: "https://agent.example.test",
    apiKey: "test-key",
    adapter,
  });

  return {
    agent,
    runtime,
    adapter,
    executeTravel,
    getActorScene,
    getRemoteActors,
    getTravelDestinations,
    actorScenes,
    fetchMock,
    sessionRequests,
    turnRequests,
    turnSignals,
    issuedCommandIds,
    setTravelHandler: (handler: AgentStageAdapter["executeTravel"]) => {
      travelHandler = handler;
    },
    setStage: (stage: AgentStageFrame) => {
      currentStage = stage;
    },
    spawnActor: (actorId: string) => {
      const spawnId = spawnIds.get(actorId);
      if (!spawnId) throw new Error(`No test spawn for ${actorId}`);
      currentStage.runtime.spawnActor({
        actorId,
        characterPack: pack,
        spawnId,
        controlOwner: "script",
      });
    },
  };
}

function advanceRuntime(runtime: StageRuntime, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) runtime.tick(50);
}

async function drainLateResponse(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAgentStage", () => {
  it("ignores a late turn response after cancellation and restores the pending input", async () => {
    const lateTurn = createDeferred<Response>();
    const harness = createAgentHarness(() => lateTurn.promise);
    const { agent, runtime } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    const initialPosition = runtime.snapshot().actors[0]?.position;
    agent.agentInput.value = "这条迟到响应不能执行";
    const sending = agent.sendAgentMessage();
    await vi.waitFor(() => expect(harness.turnRequests).toHaveLength(1));
    expect(agent.agentStatus.value).toBe("busy");
    expect(agent.agentInput.value).toBe("");

    agent.cancelAgentTurn();
    await sending;

    expect(harness.turnSignals[0]?.aborted).toBe(true);
    expect(agent.agentStatus.value).toBe("connected");
    expect(agent.agentInput.value).toBe("这条迟到响应不能执行");
    expect(agent.canRetryTurn.value).toBe(false);

    lateTurn.resolve(jsonResponse(turnPayload(
      "session-1",
      [characterReply()],
      [{ type: "actor.move_to", actor_id: stageActorId, anchor_id: "far" }],
    )));
    await drainLateResponse();
    advanceRuntime(runtime, 100);

    expect(harness.issuedCommandIds).toEqual([]);
    expect(runtime.snapshot().actors[0]?.position).toEqual(initialPosition);
    expect(runtime.snapshot().actors[0]?.speech).toBeNull();
    expect(agent.conversation.value.some((line) =>
      line.kind === "command" || line.kind === "character" || line.kind === "action",
    )).toBe(false);
    expect(agent.agentStatus.value).toBe("connected");
    expect(agent.agentInput.value).toBe("这条迟到响应不能执行");
  });

  it("cancels old actions on scene invalidation without staying busy or losing input", async () => {
    const harness = createAgentHarness((request) => jsonResponse(turnPayload(
      request.session_id,
      [characterReply()],
      [
        { type: "actor.move_to", actor_id: stageActorId, anchor_id: "far" },
        { type: "dialogue.say", actor_id: stageActorId, text: "旧场景台词" },
      ],
    )));
    const { agent, runtime } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "切换场景后恢复这句话";
    const sending = agent.sendAgentMessage();
    await vi.waitFor(() => {
      expect(runtime.snapshot().actors[0]?.active_locomotion_task_id).toBe("command-1");
    });
    expect(agent.agentStatus.value).toBe("busy");

    agent.invalidateAgent("测试切换场景");
    await sending;
    const cancelledPosition = runtime.snapshot().actors[0]?.position;
    advanceRuntime(runtime, 100);

    expect(agent.agentStatus.value).toBe("connected");
    expect(agent.agentStatusMessage.value).toBe("舞台已切换，上一轮操作已取消，请重新发送");
    expect(agent.agentInput.value).toBe("切换场景后恢复这句话");
    expect(agent.canRetryTurn.value).toBe(false);
    expect(harness.issuedCommandIds).toEqual(["command-1"]);
    expect(runtime.snapshot().actors[0]).toMatchObject({
      position: cancelledPosition,
      speech: null,
      active_locomotion_task_id: null,
    });
    expect(agent.conversation.value.some((line) => line.text === "旧场景台词")).toBe(false);
  });

  it("keeps a received character reply when a later stage action fails", async () => {
    const harness = createAgentHarness((request) => jsonResponse(turnPayload(
      request.session_id,
      [characterReply()],
      [
        { type: "actor.face", actor_id: stageActorId, facing: "left" },
        { type: "actor.move_to", actor_id: stageActorId, anchor_id: "missing" },
      ],
    )));
    const { agent, runtime } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "先转身，再去不存在的地方";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("error");
    expect(agent.agentStatusMessage.value).toContain("本轮回复已保留，但动作未全部完成");
    expect(agent.canRetryTurn.value).toBe(true);
    expect(agent.conversation.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "character", text: "你好，训练员。" }),
      expect.objectContaining({ kind: "action", text: "轻轻挥手" }),
    ]));
    expect(runtime.snapshot().actors[0]?.facing).toBe("left");
    expect(runtime.events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "command.completed", command_id: "command-1" }),
      expect.objectContaining({ type: "command.failed", command_id: "command-2" }),
    ]));
  });

  it("rebuilds and resends only through explicit retry after a session 404", async () => {
    const harness = createAgentHarness((request, turnNumber) => {
      if (turnNumber === 1) {
        return jsonResponse({ detail: "Stage session not found" }, { status: 404 });
      }
      return jsonResponse(turnPayload(request.session_id));
    });
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "404 后只应显式重发";

    await agent.sendAgentMessage();
    await drainLateResponse();

    expect(agent.agentStatus.value).toBe("error");
    expect(agent.canRetryTurn.value).toBe(true);
    expect(agent.agentInput.value).toBe("");
    expect(harness.sessionRequests).toHaveLength(1);
    expect(harness.turnRequests).toHaveLength(1);
    expect(harness.turnRequests[0]).toMatchObject({
      session_id: "session-1",
      events: [{ content: "404 后只应显式重发" }],
    });

    await agent.retryAgentSession();

    expect(harness.sessionRequests).toHaveLength(2);
    expect(harness.turnRequests).toHaveLength(2);
    expect(harness.turnRequests[1]).toMatchObject({
      session_id: "session-2",
      user_uuid: "user-2",
      events: [{ content: "404 后只应显式重发" }],
    });
    expect(agent.agentStatus.value).toBe("connected");
    expect(agent.canRetryTurn.value).toBe(false);
    expect(agent.agentInput.value).toBe("");
    expect(agent.conversation.value.filter((line) => line.kind === "trainer")).toHaveLength(1);
  });

  it("sends an absent-only turn with remote bindings and travel metadata", async () => {
    const remote = makeRemoteActor();
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id)),
      {
        supportsTravel: true,
        actors: [remote],
        destinations: [{
          sceneId: remote.sceneId,
          displayName: "训练场",
          spawnIds: ["entry", "track"],
        }],
      },
    );
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    expect(agent.agentSupportsTravel.value).toBe(true);
    agent.agentInput.value = "请从另一张地图回来";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("connected");
    expect(harness.turnRequests).toHaveLength(1);
    const request = harness.turnRequests[0]!;
    expect(request.events[0]?.target_actor_ids).toEqual([remote.agentActorId]);
    expect(request.actor_bindings).toEqual([{
      agent_actor_id: remote.agentActorId,
      stage_actor_id: remote.stageActorId,
      scene_id: remote.sceneId,
    }]);
    expect(request.live_stage.actors).toEqual([]);
    expect(request.live_stage.remote_actors).toEqual([{
      actor_id: remote.stageActorId,
      scene_id: remote.sceneId,
    }]);
    expect(request.live_stage.travel_destinations).toEqual([{
      scene_id: remote.sceneId,
      display_name: "训练场",
      spawn_ids: ["entry", "track"],
    }]);
    expect(harness.getTravelDestinations).toHaveBeenCalledTimes(1);
  });

  it("includes local and remote session actors without adding remote actors to live_stage.actors", async () => {
    const local = makeLocalActor();
    const remote = makeRemoteActor();
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id)),
      { supportsTravel: true, actors: [local, remote] },
    );
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "两个人都听到";

    await agent.sendAgentMessage();

    const request = harness.turnRequests[0]!;
    expect(request.events[0]?.target_actor_ids).toEqual([local.agentActorId, remote.agentActorId]);
    expect(request.actor_bindings).toEqual([
      { agent_actor_id: local.agentActorId, stage_actor_id: local.stageActorId, scene_id: scene.scene_id },
      { agent_actor_id: remote.agentActorId, stage_actor_id: remote.stageActorId, scene_id: remote.sceneId },
    ]);
    expect(request.live_stage.actors.map((actor) => actor.actor_id)).toEqual([local.stageActorId]);
    expect(request.live_stage.remote_actors).toEqual([{
      actor_id: remote.stageActorId,
      scene_id: remote.sceneId,
    }]);
  });

  it("keeps old backends present-only and explains why absent-only recall is unavailable", async () => {
    const local = makeLocalActor();
    const remote = makeRemoteActor();
    const presentHarness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id)),
      { actors: [local, remote] },
    );
    await expect(presentHarness.agent.prepareAgentSession()).resolves.toBe(true);
    expect(presentHarness.agent.agentSupportsTravel.value).toBe(false);
    presentHarness.agent.agentInput.value = "只和在场角色说话";

    await presentHarness.agent.sendAgentMessage();

    const request = presentHarness.turnRequests[0]!;
    expect(request.events[0]?.target_actor_ids).toEqual([local.agentActorId]);
    expect(request.actor_bindings).toEqual([{
      agent_actor_id: local.agentActorId,
      stage_actor_id: local.stageActorId,
    }]);
    expect(request.live_stage.remote_actors).toEqual([]);
    expect(request.live_stage.travel_destinations).toEqual([]);
    expect(presentHarness.getRemoteActors).not.toHaveBeenCalled();
    expect(presentHarness.getTravelDestinations).not.toHaveBeenCalled();

    const absentHarness = createAgentHarness(undefined, { actors: [remote] });
    await expect(absentHarness.agent.prepareAgentSession()).resolves.toBe(true);
    absentHarness.agent.agentInput.value = "尝试召回缺席角色";

    await absentHarness.agent.sendAgentMessage();

    expect(absentHarness.turnRequests).toHaveLength(0);
    expect(absentHarness.agent.agentStatus.value).toBe("connected");
    expect(absentHarness.agent.agentStatusMessage.value).toBe("当前 Agent 版本不支持跨图召回，请更新并重启后端");
    expect(absentHarness.agent.agentInput.value).toBe("尝试召回缺席角色");
  });

  it.each([
    {
      label: "approach",
      action: {
        type: "actor.approach",
        actor_id: "uma_remote",
        target_actor_id: "trainer",
        distance_tiles: 1,
        preferred_side: "left",
      },
    },
    {
      label: "follow",
      action: {
        type: "actor.follow",
        actor_id: "uma_remote",
        target_actor_id: "trainer",
        distance_tiles: 2,
        preferred_side: "above",
      },
    },
  ] as const)("recalls a remote actor before $label and then executes locally", async ({ action }) => {
    const remote = makeRemoteActor();
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id, [], [action])),
      { supportsTravel: true, actors: [remote], includeTrainer: true },
    );
    const order: string[] = [];
    harness.setTravelHandler(async (travelAction, signal) => {
      order.push("travel");
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(travelAction).toEqual({
        type: "actor.travel_to_scene",
        actor_id: remote.stageActorId,
        target_scene_id: scene.scene_id,
      });
      harness.actorScenes.set(remote.stageActorId, scene.scene_id);
      harness.spawnActor(remote.stageActorId);
    });
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "回来后靠近训练员";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("connected");
    expect(order).toEqual(["travel"]);
    expect(harness.executeTravel).toHaveBeenCalledTimes(1);
    expect(harness.issuedCommandIds).toEqual(["command-1"]);
    expect(harness.runtime.snapshot().actors.some((actor) => actor.actor_id === remote.stageActorId)).toBe(true);
    if (action.type === "actor.follow") {
      expect(harness.runtime.snapshot().actors.find((actor) => actor.actor_id === remote.stageActorId)?.following_actor_id).toBe("trainer");
    }
  });

  it("executes travel in response order and uses the refreshed runtime for later actions", async () => {
    const remote = makeRemoteActor();
    const refreshedRuntimes: StageRuntime[] = [];
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id, [], [
        {
          type: "actor.travel_to_scene",
          actor_id: remote.stageActorId,
          target_scene_id: scene.scene_id,
        },
        { type: "actor.face", actor_id: remote.stageActorId, facing: "left" },
      ])),
      { supportsTravel: true, actors: [remote], includeTrainer: true },
    );
    harness.setTravelHandler(async () => {
      const nextRuntime = new StageRuntime({
        ...scene,
        spawns: [
          scene.spawns[0]!,
          { id: "spawn-1", position: { x: 1, y: 0 }, facing: "right" },
        ],
      });
      nextRuntime.spawnActor({
        actorId: "trainer",
        characterPack: pack,
        spawnId: "spawn-1",
        controlOwner: "player",
      });
      refreshedRuntimes.push(nextRuntime);
      harness.setStage({
        runtime: nextRuntime,
        stageId: "agent_test_stage",
        sceneId: scene.scene_id,
        sceneName: scene.display_name,
      });
      harness.actorScenes.set(remote.stageActorId, scene.scene_id);
      harness.spawnActor(remote.stageActorId);
    });
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "先召回，再转身";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("connected");
    expect(harness.executeTravel).toHaveBeenCalledTimes(1);
    expect(harness.issuedCommandIds).toEqual(["command-1"]);
    expect(harness.runtime.snapshot().actors.some((actor) => actor.actor_id === remote.stageActorId)).toBe(false);
    expect(refreshedRuntimes[0]?.snapshot().actors.find((actor) => actor.actor_id === remote.stageActorId)?.facing).toBe("left");
  });

  it("keeps absent dialogue in conversation without creating a runtime bubble", async () => {
    const remote = makeRemoteActor();
    const reply = replyFor(remote, "远方的回复");
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id, [reply], [{
        type: "dialogue.say",
        actor_id: remote.stageActorId,
        text: "远方的回复",
      }])),
      { supportsTravel: true, actors: [remote], includeTrainer: true },
    );
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "你在另一张地图吗";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("connected");
    expect(agent.conversation.value.filter((line) => line.kind === "character" && line.text === "远方的回复")).toHaveLength(1);
    expect(harness.issuedCommandIds).toEqual([]);
    expect(harness.runtime.snapshot().actors.some((actor) => actor.actor_id === remote.stageActorId)).toBe(false);
    expect(harness.runtime.snapshot().actors.every((actor) => actor.speech === null)).toBe(true);
    expect(harness.runtime.events().some((event) => event.type === "command.failed")).toBe(false);
  });

  it("reports a clear error for other actions whose actor is absent", async () => {
    const remote = makeRemoteActor();
    const harness = createAgentHarness(
      (request) => jsonResponse(turnPayload(request.session_id, [], [{
        type: "actor.face",
        actor_id: remote.stageActorId,
        facing: "left",
      }])),
      { supportsTravel: true, actors: [remote], includeTrainer: true },
    );
    const { agent } = harness;
    await expect(agent.prepareAgentSession()).resolves.toBe(true);
    agent.agentInput.value = "缺席角色不能本地转身";

    await agent.sendAgentMessage();

    expect(agent.agentStatus.value).toBe("error");
    expect(agent.agentStatusMessage.value).toContain("角色不在当前场景");
    expect(agent.agentStatusMessage.value).toContain(remote.stageActorId);
    expect(harness.issuedCommandIds).toEqual([]);
  });
});

function makeLocalActor(): HarnessActor {
  return {
    characterId: "admire_vega",
    displayName,
    stageActorId,
    agentActorId,
    present: true,
    sceneId: scene.scene_id,
  };
}

function makeRemoteActor(): HarnessActor {
  return {
    characterId: "remote_character",
    displayName: "特别周",
    stageActorId: "uma_remote",
    agentActorId: "agent_remote",
    present: false,
    sceneId: "remote_scene",
  };
}

function replyFor(actor: HarnessActor, text: string) {
  return {
    ...characterReply(),
    event_id: `reply-${actor.agentActorId}`,
    content: text,
    dialogue: text,
    actor: { actor_id: actor.agentActorId, display_name: actor.displayName },
  };
}
