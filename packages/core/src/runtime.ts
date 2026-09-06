import {
  stageCommandSchema,
  type ActorRelativeSide,
  type CharacterPack,
  type ControlOwner,
  type Direction,
  type FollowActorCommand,
  type FollowActivityPathCommand,
  type MoveToCommand,
  type SceneAnchor,
  type ScenePack,
  type StageActorState,
  type StageCommand,
  type StageEvent,
  type StageSnapshot,
  type TilePosition,
  type WorldPosition,
} from "@uma-stage/contracts";

import { GridNavigation, tileKey } from "./navigation";
import { RuntimeTask, type StageTask } from "./task";

export interface SpawnActorOptions {
  actorId: string;
  characterPack: CharacterPack;
  spawnId: string;
  controlOwner: ControlOwner;
  speedPxPerSecond?: number;
}

export interface ActorInspection {
  actor_id: string;
  tile: TilePosition;
  facing: Direction;
  locomotion: StageActorState["locomotion"];
  control_owner: ControlOwner;
  following_actor_id: string | null;
  follow_distance_tiles: number | null;
  nearby_anchors: string[];
}

export interface StageInspection {
  actors: ActorInspection[];
  anchors: Array<{
    id: string;
    display_name: string;
    description: string;
    tags: string[];
    available_slots: string[];
  }>;
  activity_paths: Array<{ id: string; activity_id: string; loop: boolean }>;
  portals: Array<{
    id: string;
    target_scene_id: string;
    target_spawn_id: string;
  }>;
}

interface ActorRecord {
  state: StageActorState;
  speed: number;
  idleAfterMs: number;
  idleElapsedMs: number;
  manualIntent: WorldPosition;
  activeMove: ActiveMove | null;
  activeFollow: ActiveFollow | null;
  moveQueue: QueuedMove[];
  activeSpeech: ActiveSpeech | null;
  lastPortalId: string | null;
}

interface QueuedMove {
  command: LocomotionCommand;
  task: RuntimeTask;
}

interface ActiveMove extends QueuedMove {
  path: WorldPosition[];
  reservationKey: string;
  finalFacing?: Direction;
}

interface ActiveFollow {
  targetActorId: string;
  distanceTiles: number;
  preferredSide: ActorRelativeSide;
  path: WorldPosition[];
  repathElapsedMs: number;
  targetTileKey: string | null;
}

interface ActiveSpeech {
  task: RuntimeTask;
  remainingMs: number;
}

type LocomotionCommand = MoveToCommand | FollowActivityPathCommand;

export class StageRuntime {
  readonly navigation: GridNavigation;
  readonly #actors = new Map<string, ActorRecord>();
  readonly #reservations = new Map<string, string>();
  readonly #events: StageEvent[] = [];
  readonly #subscribers = new Set<(event: StageEvent) => void>();
  #sequence = 0;
  #timeMs = 0;

  constructor(readonly scene: ScenePack) {
    this.navigation = new GridNavigation(scene);
  }

  spawnActor(options: SpawnActorOptions): void {
    if (this.#actors.has(options.actorId)) throw new Error(`Actor already exists: ${options.actorId}`);
    const spawn = this.scene.spawns.find((candidate) => candidate.id === options.spawnId);
    if (!spawn) throw new Error(`Unknown spawn: ${options.spawnId}`);
    const occupiedBy = [...this.#actors.values()].find((record) =>
      sameTile(this.navigation.worldToTile(record.state.position), spawn.position),
    );
    if (occupiedBy) {
      throw new Error(`Spawn tile ${options.spawnId} is occupied by ${occupiedBy.state.actor_id}`);
    }
    const state: StageActorState = {
      actor_id: options.actorId,
      character_pack_id: options.characterPack.actor_id,
      position: this.navigation.tileToWorld(spawn.position),
      facing: spawn.facing,
      locomotion: "stand",
      control_owner: options.controlOwner,
      speech: null,
      active_locomotion_task_id: null,
      following_actor_id: null,
      follow_distance_tiles: null,
    };
    this.#actors.set(options.actorId, {
      state,
      speed: options.speedPxPerSecond ?? options.characterPack.movement.speed_px_per_second,
      idleAfterMs: options.characterPack.movement.idle_after_ms,
      idleElapsedMs: 0,
      manualIntent: { x: 0, y: 0 },
      activeMove: null,
      activeFollow: null,
      moveQueue: [],
      activeSpeech: null,
      lastPortalId: null,
    });
    this.emit("actor.spawned", { actor_id: options.actorId, data: { spawn_id: options.spawnId } });
  }

  execute(input: StageCommand): StageTask {
    const command = stageCommandSchema.parse(input);
    const task = new RuntimeTask(command.id);
    const actor = this.#actors.get(command.actor_id);
    if (!actor) {
      this.failTask(task, command, "ACTOR_NOT_FOUND", `Actor not found: ${command.actor_id}`);
      return task;
    }
    if (command.source !== "system" && actor.state.control_owner !== command.source) {
      this.failTask(
        task,
        command,
        "CONTROL_DENIED",
        `${command.source} does not control ${command.actor_id}`,
      );
      return task;
    }

    this.emit("command.accepted", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });

    if (command.type === "actor.move_to" || command.type === "actor.follow_activity_path") {
      return this.enqueueMove(actor, command, task);
    }
    if (command.type === "actor.follow") return this.startFollowing(actor, command, task);
    if (command.type === "dialogue.say") return this.startSpeech(actor, command, task);

    if (command.type === "actor.face_actor") {
      const targetActor = this.#actors.get(command.target_actor_id);
      if (!targetActor) {
        this.failTask(
          task,
          command,
          "ACTOR_NOT_FOUND",
          `Face target not found: ${command.target_actor_id}`,
        );
        return task;
      }
      const from = this.navigation.worldToTile(actor.state.position);
      const target = this.navigation.worldToTile(targetActor.state.position);
      const facing = facingToward(from, target);
      if (!facing) {
        this.failTask(task, command, "INVALID_TARGET", "Actors occupy the same tile");
        return task;
      }
      task.start();
      this.emit("command.started", {
        actor_id: command.actor_id,
        command_id: command.id,
        data: { command_type: command.type },
      });
      this.setFacing(actor, facing);
      this.completeTask(task, command);
      return task;
    }

    task.start();
    this.emit("command.started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });
    if (command.type === "actor.stop") {
      this.cancelActiveMove(actor, "Stopped by command", false);
      actor.moveQueue.splice(0).forEach((queued) => this.cancelQueuedMove(queued, "Stopped by command"));
      this.stopFollowing(actor, "Stopped by command");
      actor.manualIntent = { x: 0, y: 0 };
      actor.state.locomotion = "stand";
    } else if (command.type === "actor.stop_follow") {
      this.stopFollowing(actor, "Stopped by command");
    } else if (command.type === "actor.face") {
      this.setFacing(actor, command.facing);
    }
    this.completeTask(task, command);
    return task;
  }

  tick(deltaMs: number): void {
    const boundedDelta = Math.max(0, Math.min(deltaMs, 100));
    this.#timeMs += boundedDelta;
    for (const actor of this.#actors.values()) {
      if (actor.activeMove) this.tickMove(actor, boundedDelta);
      else if (actor.activeFollow) this.tickFollowing(actor, boundedDelta);
      else this.tickManualMovement(actor, boundedDelta);
      this.tickLocomotion(actor, boundedDelta);
      this.tickSpeech(actor, boundedDelta);
      this.tickPortal(actor);
    }
  }

  setPlayerIntent(actorId: string, x: number, y: number): boolean {
    const actor = this.#actors.get(actorId);
    if (!actor || actor.state.control_owner !== "player") return false;
    const length = Math.hypot(x, y);
    const next = length > 1 ? { x: x / length, y: y / length } : { x, y };
    if ((next.x !== 0 || next.y !== 0) && actor.activeMove) {
      this.cancelActiveMove(actor, "Player input replaced locomotion", false);
      actor.moveQueue
        .splice(0)
        .forEach((queued) => this.cancelQueuedMove(queued, "Player input replaced locomotion"));
    }
    if (next.x !== 0 || next.y !== 0) {
      this.stopFollowing(actor, "Player input replaced following");
    }
    actor.manualIntent = next;
    return true;
  }

  setControlOwner(actorId: string, owner: ControlOwner): void {
    const actor = this.requireActor(actorId);
    if (actor.state.control_owner === owner) return;
    this.cancelActiveMove(actor, "Control owner changed", false);
    actor.moveQueue.splice(0).forEach((queued) => this.cancelQueuedMove(queued, "Control owner changed"));
    this.stopFollowing(actor, "Control owner changed");
    actor.manualIntent = { x: 0, y: 0 };
    const previous = actor.state.control_owner;
    actor.state.control_owner = owner;
    actor.state.locomotion = "stand";
    this.emit("control.changed", { actor_id: actorId, data: { from: previous, to: owner } });
  }

  snapshot(): StageSnapshot {
    return {
      scene_id: this.scene.scene_id,
      time_ms: this.#timeMs,
      actors: [...this.#actors.values()].map((record) => ({
        ...record.state,
        position: { ...record.state.position },
      })),
    };
  }

  events(limit = 100): StageEvent[] {
    return this.#events.slice(-Math.max(0, limit)).map((event) => ({ ...event, data: { ...event.data } }));
  }

  subscribe(handler: (event: StageEvent) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  inspect(): StageInspection {
    const actors = [...this.#actors.values()].map((record) => {
      const tile = this.navigation.worldToTile(record.state.position);
      return {
        actor_id: record.state.actor_id,
        tile,
        facing: record.state.facing,
        locomotion: record.state.locomotion,
        control_owner: record.state.control_owner,
        following_actor_id: record.state.following_actor_id,
        follow_distance_tiles: record.state.follow_distance_tiles,
        nearby_anchors: this.scene.anchors
          .filter((anchor) => manhattan(tile, anchor.position) <= 4)
          .map((anchor) => anchor.id),
      };
    });
    return {
      actors,
      anchors: this.scene.anchors.map((anchor) => ({
        id: anchor.id,
        display_name: anchor.display_name,
        description: anchor.description,
        tags: [...anchor.tags],
        available_slots: anchor.slots
          .filter((slot) => !this.#reservations.has(tileKey(slot.position)))
          .map((slot) => slot.id),
      })),
      activity_paths: this.scene.activity_paths.map((path) => ({
        id: path.id,
        activity_id: path.activity_id,
        loop: path.loop,
      })),
      portals: this.scene.portals.map((portal) => ({
        id: portal.id,
        target_scene_id: portal.target_scene_id,
        target_spawn_id: portal.target_spawn_id,
      })),
    };
  }

  private startFollowing(
    actor: ActorRecord,
    command: FollowActorCommand,
    task: RuntimeTask,
  ): StageTask {
    if (command.target_actor_id === command.actor_id) {
      this.failTask(task, command, "INVALID_TARGET", "An actor cannot follow itself");
      return task;
    }
    if (!this.#actors.has(command.target_actor_id)) {
      this.failTask(
        task,
        command,
        "ACTOR_NOT_FOUND",
        `Follow target not found: ${command.target_actor_id}`,
      );
      return task;
    }
    if ((actor.activeMove || actor.activeFollow || actor.moveQueue.length > 0) && command.policy !== "replace") {
      this.failTask(task, command, "CHANNEL_BUSY", "Locomotion channel is busy");
      return task;
    }

    this.cancelActiveMove(actor, `Replaced by ${command.id}`, false);
    actor.moveQueue
      .splice(0)
      .forEach((queued) => this.cancelQueuedMove(queued, `Replaced by ${command.id}`));
    this.stopFollowing(actor, `Replaced by ${command.id}`);
    actor.manualIntent = { x: 0, y: 0 };

    task.start();
    actor.activeFollow = {
      targetActorId: command.target_actor_id,
      distanceTiles: command.distance_tiles,
      preferredSide: command.preferred_side ?? "nearest",
      path: [],
      repathElapsedMs: 0,
      targetTileKey: null,
    };
    actor.state.following_actor_id = command.target_actor_id;
    actor.state.follow_distance_tiles = command.distance_tiles;
    actor.state.active_locomotion_task_id = null;
    actor.state.locomotion = "stand";
    actor.idleElapsedMs = 0;
    this.emit("command.started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });
    this.emit("actor.follow_started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: {
        target_actor_id: command.target_actor_id,
        distance_tiles: command.distance_tiles,
      },
    });
    this.completeTask(task, command);
    return task;
  }

  private stopFollowing(actor: ActorRecord, reason: string): boolean {
    const follow = actor.activeFollow;
    if (!follow) return false;
    actor.activeFollow = null;
    actor.state.following_actor_id = null;
    actor.state.follow_distance_tiles = null;
    if (!actor.activeMove && actor.manualIntent.x === 0 && actor.manualIntent.y === 0) {
      actor.state.locomotion = "stand";
      actor.idleElapsedMs = 0;
    }
    this.emit("actor.follow_stopped", {
      actor_id: actor.state.actor_id,
      data: { target_actor_id: follow.targetActorId, reason },
    });
    return true;
  }

  private enqueueMove(actor: ActorRecord, command: LocomotionCommand, task: RuntimeTask): StageTask {
    if (actor.activeFollow) {
      if (command.policy !== "replace") {
        this.failTask(task, command, "CHANNEL_BUSY", "Locomotion channel is following an actor");
        return task;
      }
      this.stopFollowing(actor, `Replaced by ${command.id}`);
    }
    if (actor.activeMove) {
      if (command.policy === "reject") {
        this.failTask(task, command, "CHANNEL_BUSY", "Locomotion channel is busy");
        return task;
      }
      if (command.policy === "replace") {
        // A replacement starts ahead of already queued work. Cancelling must not
        // briefly promote a queued command into the active channel.
        this.cancelActiveMove(actor, `Replaced by ${command.id}`, false);
      }
      if (command.policy === "queue") {
        actor.moveQueue.push({ command, task });
        task.onCancel((reason) => {
          const index = actor.moveQueue.findIndex((queued) => queued.task === task);
          if (index >= 0) actor.moveQueue.splice(index, 1);
          this.cancelQueuedMove({ command, task }, reason);
        });
        return task;
      }
    }
    this.startMove(actor, command, task);
    return task;
  }

  private startMove(actor: ActorRecord, command: LocomotionCommand, task: RuntimeTask): void {
    const from = this.navigation.worldToTile(actor.state.position);
    const resolved =
      command.type === "actor.move_to"
        ? this.resolvePointMove(command, from, actor.state.actor_id)
        : this.resolveActivityMove(command, from, actor.state.actor_id);
    if (!resolved) {
      this.failTask(task, command, "NO_REACHABLE_TARGET", "No reachable target or free anchor slot");
      this.startNextQueuedMove(actor);
      return;
    }
    const { path, target } = resolved;
    const reservationKey = tileKey(target.position);
    this.#reservations.set(reservationKey, actor.state.actor_id);
    task.onCancel((reason) => this.cancelActiveMove(actor, reason));
    task.start();
    actor.activeMove = {
      command,
      task,
      path: path.map((position) => this.navigation.tileToWorld(position)),
      reservationKey,
      ...(target.facing ? { finalFacing: target.facing } : {}),
    };
    actor.state.active_locomotion_task_id = command.id;
    actor.state.locomotion = path.length > 0 ? "walk" : "stand";
    actor.idleElapsedMs = 0;
    this.emit("command.started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });
    this.emit("actor.movement_started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { target: target.position },
    });
    if (path.length === 0) this.finishMove(actor);
  }

  private resolvePointMove(
    command: MoveToCommand,
    from: TilePosition,
    actorId: string,
  ): { path: TilePosition[]; target: { position: TilePosition; facing?: Direction } } | null {
    const target = this.resolveMoveTarget(command, from, actorId);
    if (!target) return null;
    const path = this.navigation.findPath(from, target.position, {
      isOccupied: (position) => this.isOccupied(position, actorId),
    });
    if (path.length === 0 && !sameTile(from, target.position)) return null;
    return { path, target };
  }

  private resolveActivityMove(
    command: FollowActivityPathCommand,
    from: TilePosition,
    actorId: string,
  ): { path: TilePosition[]; target: { position: TilePosition; facing?: Direction } } | null {
    const activity = this.scene.activity_paths.find(
      (candidate) => candidate.id === command.activity_path_id,
    );
    if (!activity) return null;
    const checkpoints: TilePosition[] = [];
    for (let cycle = 0; cycle < command.cycles; cycle += 1) {
      checkpoints.push(...activity.points);
      if (activity.loop && activity.points[0]) checkpoints.push(activity.points[0]);
    }

    const path: TilePosition[] = [];
    let current = from;
    for (const checkpoint of checkpoints) {
      const segment = this.navigation.findPath(current, checkpoint, {
        isOccupied: (position) => this.isOccupied(position, actorId),
      });
      if (segment.length === 0 && !sameTile(current, checkpoint)) return null;
      path.push(...segment);
      current = checkpoint;
    }
    const anchor = activity.anchor_id
      ? this.scene.anchors.find((candidate) => candidate.id === activity.anchor_id)
      : undefined;
    return {
      path,
      target: {
        position: current,
        ...(anchor?.facing ? { facing: anchor.facing } : {}),
      },
    };
  }

  private resolveMoveTarget(
    command: MoveToCommand,
    from: TilePosition,
    actorId: string,
  ): { position: TilePosition; facing?: Direction } | null {
    if (command.target.type === "tile") {
      const position = this.navigation.findNearestAvailable(command.target.position, {
        from,
        maxRadius: 3,
        isOccupied: (candidate) => this.isOccupiedOrReserved(candidate, actorId),
      });
      return position ? { position } : null;
    }
    if (command.target.type === "actor") {
      return this.resolveActorTarget(
        command.target.id,
        command.target.distance_tiles,
        command.target.preferred_side ?? "nearest",
        from,
        actorId,
      );
    }
    const target = command.target;
    const anchor = this.scene.anchors.find((candidate) => candidate.id === target.id);
    if (!anchor) return null;
    return this.resolveAnchorTarget(anchor, target.slot_id, from, actorId);
  }

  private resolveActorTarget(
    targetActorId: string,
    distanceTiles: number,
    preferredSide: ActorRelativeSide,
    from: TilePosition,
    actorId: string,
  ): { position: TilePosition; facing?: Direction } | null {
    if (targetActorId === actorId) return null;
    const targetActor = this.#actors.get(targetActorId);
    if (!targetActor) return null;
    const targetTile = this.navigation.worldToTile(targetActor.state.position);
    const desiredDistance = Math.max(1, Math.min(4, distanceTiles));
    if (
      manhattan(from, targetTile) === desiredDistance &&
      matchesPreferredSide(from, targetTile, preferredSide)
    ) {
      const facing = facingToward(from, targetTile);
      return { position: from, ...(facing ? { facing } : {}) };
    }

    const candidates: Array<{ position: TilePosition; pathLength: number }> = [];
    for (let radius = 1; radius <= desiredDistance; radius += 1) {
      for (const candidate of tilesAtDistance(targetTile, radius)) {
        if (this.isOccupiedOrReserved(candidate, actorId)) continue;
        const path = this.navigation.findPath(from, candidate, {
          isOccupied: (position) => this.isOccupiedOrReserved(position, actorId),
        });
        if (path.length === 0 && !sameTile(from, candidate)) continue;
        candidates.push({ position: candidate, pathLength: path.length });
      }
    }
    candidates.sort((left, right) =>
      Number(!matchesPreferredSide(left.position, targetTile, preferredSide)) -
        Number(!matchesPreferredSide(right.position, targetTile, preferredSide)) ||
      Math.abs(desiredDistance - manhattan(left.position, targetTile)) -
        Math.abs(desiredDistance - manhattan(right.position, targetTile)) ||
      preferredSideRank(left.position, targetTile, preferredSide) -
        preferredSideRank(right.position, targetTile, preferredSide) ||
      left.pathLength - right.pathLength,
    );
    const selected = candidates[0]?.position;
    if (!selected) return null;
    const facing = facingToward(selected, targetTile);
    return { position: selected, ...(facing ? { facing } : {}) };
  }

  private resolveAnchorTarget(
    anchor: SceneAnchor,
    slotId: string | undefined,
    from: TilePosition,
    actorId: string,
  ): { position: TilePosition; facing?: Direction } | null {
    const slots = slotId ? anchor.slots.filter((slot) => slot.id === slotId) : anchor.slots;
    const candidates = [...slots, { id: "anchor", position: anchor.position, facing: anchor.facing }]
      .map((candidate) => ({
        candidate,
        path: this.navigation.findPath(from, candidate.position, {
          isOccupied: (position) => this.isOccupiedOrReserved(position, actorId),
        }),
      }))
      .filter(({ candidate, path }) => {
        if (this.isOccupiedOrReserved(candidate.position, actorId)) return false;
        return sameTile(from, candidate.position) || path.length > 0;
      })
      .sort((left, right) => left.path.length - right.path.length);
    const selected = candidates[0]?.candidate;
    if (!selected) return null;
    return {
      position: selected.position,
      ...(selected.facing ? { facing: selected.facing } : {}),
    };
  }

  private tickMove(actor: ActorRecord, deltaMs: number): void {
    const move = actor.activeMove;
    if (!move) return;
    const target = move.path[0];
    if (!target) {
      this.finishMove(actor);
      return;
    }
    const dx = target.x - actor.state.position.x;
    const dy = target.y - actor.state.position.y;
    const distance = Math.hypot(dx, dy);
    const travel = (actor.speed * deltaMs) / 1000;
    this.setFacingFromVector(actor, dx, dy);
    if (distance <= travel || distance < 0.01) {
      actor.state.position = { ...target };
      move.path.shift();
      if (move.path.length === 0) this.finishMove(actor);
      return;
    }
    actor.state.position = {
      x: actor.state.position.x + (dx / distance) * travel,
      y: actor.state.position.y + (dy / distance) * travel,
    };
    actor.state.locomotion = "walk";
    actor.idleElapsedMs = 0;
  }

  private tickFollowing(actor: ActorRecord, deltaMs: number): void {
    const follow = actor.activeFollow;
    if (!follow) return;
    const targetActor = this.#actors.get(follow.targetActorId);
    if (!targetActor) {
      this.stopFollowing(actor, "Follow target left the stage");
      return;
    }

    const from = this.navigation.worldToTile(actor.state.position);
    const targetTile = this.navigation.worldToTile(targetActor.state.position);
    const nextTargetKey = tileKey(targetTile);
    follow.repathElapsedMs -= deltaMs;

    if (manhattan(from, targetTile) <= follow.distanceTiles) {
      follow.path = [];
      follow.targetTileKey = nextTargetKey;
      const facing = facingToward(from, targetTile);
      if (facing) this.setFacing(actor, facing);
      if (actor.state.locomotion === "walk") {
        actor.state.locomotion = "stand";
        actor.idleElapsedMs = 0;
      }
      return;
    }

    if (
      follow.path.length === 0 ||
      follow.repathElapsedMs <= 0 ||
      follow.targetTileKey !== nextTargetKey
    ) {
      follow.path = this.planFollowPath(
        actor.state.actor_id,
        follow.targetActorId,
        follow.distanceTiles,
        follow.preferredSide,
      );
      follow.repathElapsedMs = 250;
      follow.targetTileKey = nextTargetKey;
    }

    const target = follow.path[0];
    if (!target) {
      actor.state.locomotion = "stand";
      return;
    }
    if (!this.canOccupyWorld(actor.state.actor_id, target)) {
      follow.path = [];
      follow.repathElapsedMs = 0;
      actor.state.locomotion = "stand";
      return;
    }

    const dx = target.x - actor.state.position.x;
    const dy = target.y - actor.state.position.y;
    const distance = Math.hypot(dx, dy);
    const travel = (actor.speed * deltaMs) / 1000;
    this.setFacingFromVector(actor, dx, dy);
    if (distance <= travel || distance < 0.01) {
      actor.state.position = { ...target };
      follow.path.shift();
    } else {
      actor.state.position = {
        x: actor.state.position.x + (dx / distance) * travel,
        y: actor.state.position.y + (dy / distance) * travel,
      };
    }
    actor.state.locomotion = "walk";
    actor.idleElapsedMs = 0;
  }

  private planFollowPath(
    actorId: string,
    targetActorId: string,
    distanceTiles: number,
    preferredSide: ActorRelativeSide,
  ): WorldPosition[] {
    const actor = this.#actors.get(actorId);
    const targetActor = this.#actors.get(targetActorId);
    if (!actor || !targetActor) return [];
    const from = this.navigation.worldToTile(actor.state.position);
    const targetTile = this.navigation.worldToTile(targetActor.state.position);

    const candidates = Array.from({ length: distanceTiles }, (_, index) => distanceTiles - index)
      .flatMap((radius) => tilesAtDistance(targetTile, radius))
        .filter((candidate) => !this.isOccupiedOrReserved(candidate, actorId))
        .map((candidate) => ({
          candidate,
          path: this.navigation.findPath(from, candidate, {
            isOccupied: (position) => this.isOccupiedOrReserved(position, actorId),
          }),
        }))
        .filter(({ candidate, path }) => sameTile(from, candidate) || path.length > 0)
        .sort((left, right) =>
          preferredSideRank(left.candidate, targetTile, preferredSide) -
            preferredSideRank(right.candidate, targetTile, preferredSide) ||
          manhattan(right.candidate, targetTile) - manhattan(left.candidate, targetTile) ||
          left.path.length - right.path.length,
        );
    return (candidates[0]?.path ?? []).map((position) => this.navigation.tileToWorld(position));
  }

  private finishMove(actor: ActorRecord): void {
    const move = actor.activeMove;
    if (!move) return;
    if (move.finalFacing) this.setFacing(actor, move.finalFacing);
    this.#reservations.delete(move.reservationKey);
    actor.activeMove = null;
    actor.state.active_locomotion_task_id = null;
    actor.state.locomotion = "stand";
    actor.idleElapsedMs = 0;
    this.emit("actor.arrived", {
      actor_id: move.command.actor_id,
      command_id: move.command.id,
      data: { tile: this.navigation.worldToTile(actor.state.position) },
    });
    this.completeTask(move.task, move.command);
    this.startNextQueuedMove(actor);
  }

  private cancelActiveMove(actor: ActorRecord, reason: string, drainQueue = true): void {
    const move = actor.activeMove;
    if (!move) return;
    this.#reservations.delete(move.reservationKey);
    actor.activeMove = null;
    actor.state.active_locomotion_task_id = null;
    actor.state.locomotion = "stand";
    move.task.finishCancellation(reason);
    this.emit("command.cancelled", {
      actor_id: move.command.actor_id,
      command_id: move.command.id,
      data: { reason },
    });
    if (drainQueue) this.startNextQueuedMove(actor);
  }

  private cancelQueuedMove(queued: QueuedMove, reason: string): void {
    queued.task.finishCancellation(reason);
    this.emit("command.cancelled", {
      actor_id: queued.command.actor_id,
      command_id: queued.command.id,
      data: { reason },
    });
  }

  private startNextQueuedMove(actor: ActorRecord): void {
    if (actor.activeMove) return;
    const next = actor.moveQueue.shift();
    if (next) this.startMove(actor, next.command, next.task);
  }

  private tickManualMovement(actor: ActorRecord, deltaMs: number): void {
    const intent = actor.manualIntent;
    if (intent.x === 0 && intent.y === 0) return;
    const distance = (actor.speed * deltaMs) / 1000;
    const dx = intent.x * distance;
    const dy = intent.y * distance;
    const combined = { x: actor.state.position.x + dx, y: actor.state.position.y + dy };
    if (this.canOccupyWorld(actor.state.actor_id, combined)) {
      actor.state.position = combined;
    } else {
      const horizontal = { x: actor.state.position.x + dx, y: actor.state.position.y };
      const vertical = { x: actor.state.position.x, y: actor.state.position.y + dy };
      if (this.canOccupyWorld(actor.state.actor_id, horizontal)) actor.state.position = horizontal;
      if (this.canOccupyWorld(actor.state.actor_id, vertical)) actor.state.position = vertical;
    }
    this.setFacingFromVector(actor, intent.x, intent.y);
    actor.state.locomotion = "walk";
    actor.idleElapsedMs = 0;
  }

  private tickLocomotion(actor: ActorRecord, deltaMs: number): void {
    if (
      actor.activeMove ||
      (actor.activeFollow && actor.activeFollow.path.length > 0) ||
      actor.manualIntent.x !== 0 ||
      actor.manualIntent.y !== 0
    ) return;
    actor.idleElapsedMs += deltaMs;
    actor.state.locomotion = actor.idleElapsedMs >= actor.idleAfterMs ? "idle" : "stand";
  }

  private startSpeech(
    actor: ActorRecord,
    command: Extract<StageCommand, { type: "dialogue.say" }>,
    task: RuntimeTask,
  ): StageTask {
    if (actor.activeSpeech) {
      if (command.policy === "reject") {
        this.failTask(task, command, "CHANNEL_BUSY", "Speech channel is busy");
        return task;
      }
      actor.activeSpeech.task.cancel(`Replaced by ${command.id}`);
    }
    const duration = command.duration_ms ?? Math.max(1600, Math.min(8000, command.text.length * 110));
    task.onCancel((reason) => {
      if (actor.activeSpeech?.task !== task) return;
      actor.activeSpeech = null;
      actor.state.speech = null;
      task.finishCancellation(reason);
      this.emit("command.cancelled", {
        actor_id: command.actor_id,
        command_id: command.id,
        data: { reason },
      });
    });
    task.start();
    actor.activeSpeech = { task, remainingMs: duration };
    actor.state.speech = command.text;
    this.emit("command.started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });
    this.emit("dialogue.started", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { text: command.text, duration_ms: duration },
    });
    return task;
  }

  private tickSpeech(actor: ActorRecord, deltaMs: number): void {
    const speech = actor.activeSpeech;
    if (!speech) return;
    speech.remainingMs -= deltaMs;
    if (speech.remainingMs > 0) return;
    actor.activeSpeech = null;
    actor.state.speech = null;
    this.emit("dialogue.completed", {
      actor_id: actor.state.actor_id,
      command_id: speech.task.id,
    });
    speech.task.complete();
    this.emit("command.completed", {
      actor_id: actor.state.actor_id,
      command_id: speech.task.id,
    });
  }

  private tickPortal(actor: ActorRecord): void {
    const tile = this.navigation.worldToTile(actor.state.position);
    const portal = this.scene.portals.find((candidate) => sameTile(candidate.position, tile));
    if (!portal) {
      actor.lastPortalId = null;
      return;
    }
    if (actor.lastPortalId === portal.id) return;
    actor.lastPortalId = portal.id;
    this.emit("portal.entered", {
      actor_id: actor.state.actor_id,
      data: {
        portal_id: portal.id,
        target_scene_id: portal.target_scene_id,
        target_spawn_id: portal.target_spawn_id,
      },
    });
  }

  private canOccupyWorld(actorId: string, position: WorldPosition): boolean {
    const tile = this.navigation.worldToTile(position);
    return this.navigation.isWalkable(tile) && !this.isOccupied(tile, actorId);
  }

  private isOccupied(position: TilePosition, ignoreActorId: string): boolean {
    return [...this.#actors.values()].some(
      (record) =>
        record.state.actor_id !== ignoreActorId &&
        sameTile(this.navigation.worldToTile(record.state.position), position),
    );
  }

  private isOccupiedOrReserved(position: TilePosition, actorId: string): boolean {
    const reservedBy = this.#reservations.get(tileKey(position));
    return this.isOccupied(position, actorId) || (reservedBy !== undefined && reservedBy !== actorId);
  }

  private setFacingFromVector(actor: ActorRecord, x: number, y: number): void {
    if (x === 0 && y === 0) return;
    const facing =
      Math.abs(x) > Math.abs(y) ? (x < 0 ? "left" : "right") : y < 0 ? "up" : "down";
    this.setFacing(actor, facing);
  }

  private setFacing(actor: ActorRecord, facing: Direction): void {
    if (actor.state.facing === facing) return;
    actor.state.facing = facing;
    this.emit("actor.facing_changed", { actor_id: actor.state.actor_id, data: { facing } });
  }

  private completeTask(task: RuntimeTask, command: StageCommand): void {
    task.complete();
    this.emit("command.completed", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { command_type: command.type },
    });
  }

  private failTask(
    task: RuntimeTask,
    command: StageCommand,
    code: string,
    message: string,
  ): void {
    task.fail(code, message);
    this.emit("command.failed", {
      actor_id: command.actor_id,
      command_id: command.id,
      data: { code, message },
    });
  }

  private emit(
    type: StageEvent["type"],
    fields: Omit<StageEvent, "sequence" | "time_ms" | "type" | "data"> & {
      data?: Record<string, unknown>;
    } = {},
  ): void {
    const event: StageEvent = {
      sequence: this.#sequence++,
      time_ms: this.#timeMs,
      type,
      data: fields.data ?? {},
      ...(fields.actor_id ? { actor_id: fields.actor_id } : {}),
      ...(fields.command_id ? { command_id: fields.command_id } : {}),
    };
    this.#events.push(event);
    if (this.#events.length > 1000) this.#events.shift();
    this.#subscribers.forEach((subscriber) => subscriber(event));
  }

  private requireActor(actorId: string): ActorRecord {
    const actor = this.#actors.get(actorId);
    if (!actor) throw new Error(`Actor not found: ${actorId}`);
    return actor;
  }
}

function sameTile(left: TilePosition, right: TilePosition): boolean {
  return left.x === right.x && left.y === right.y;
}

function manhattan(left: TilePosition, right: TilePosition): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function tilesAtDistance(center: TilePosition, distance: number): TilePosition[] {
  const result: TilePosition[] = [];
  for (let dx = -distance; dx <= distance; dx += 1) {
    const dy = distance - Math.abs(dx);
    result.push({ x: center.x + dx, y: center.y + dy });
    if (dy !== 0) result.push({ x: center.x + dx, y: center.y - dy });
  }
  return result;
}

function facingToward(from: TilePosition, to: TilePosition): Direction | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return undefined;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function matchesPreferredSide(
  position: TilePosition,
  target: TilePosition,
  preferredSide: ActorRelativeSide,
): boolean {
  if (preferredSide === "nearest") return true;
  if (preferredSide === "above") return position.y < target.y;
  if (preferredSide === "below") return position.y > target.y;
  if (preferredSide === "left") return position.x < target.x;
  return position.x > target.x;
}

function preferredSideRank(
  position: TilePosition,
  target: TilePosition,
  preferredSide: ActorRelativeSide,
): number {
  if (preferredSide === "nearest") return 0;
  if (!matchesPreferredSide(position, target, preferredSide)) return 10_000;
  return preferredSide === "above" || preferredSide === "below"
    ? Math.abs(position.x - target.x)
    : Math.abs(position.y - target.y);
}
