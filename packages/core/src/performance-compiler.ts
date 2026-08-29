import type {
  CameraCue,
  PerformanceCue,
  StageCommand,
} from "@uma-stage/contracts";

export type CompiledPerformanceCue =
  | { kind: "command"; command: StageCommand }
  | { kind: "camera"; cue: CameraCue }
  | {
      kind: "narration";
      text: string;
      subtitleJa?: string;
      subtitleZh?: string;
      audioPath?: string;
      durationMs?: number;
    }
  | { kind: "wait"; durationMs: number };

export function compilePerformanceCue(
  cue: PerformanceCue,
  actorIdByRole: Readonly<Record<string, string>>,
): CompiledPerformanceCue {
  if (cue.type === "stage.wait") {
    return { kind: "wait", durationMs: cue.duration_ms };
  }
  if (cue.type === "narration.say") {
    return {
      kind: "narration",
      text: cue.text,
      ...(cue.subtitle_ja === undefined ? {} : { subtitleJa: cue.subtitle_ja }),
      ...(cue.subtitle_zh === undefined ? {} : { subtitleZh: cue.subtitle_zh }),
      ...(cue.audio_path === undefined ? {} : { audioPath: cue.audio_path }),
      ...(cue.duration_ms === undefined ? {} : { durationMs: cue.duration_ms }),
    };
  }
  if (cue.type === "camera.overview") {
    return {
      kind: "camera",
      cue: { type: "camera.overview", transition_ms: cue.transition_ms },
    };
  }
  if (cue.type === "camera.fixed") {
    return {
      kind: "camera",
      cue: {
        type: cue.type,
        center: cue.center,
        zoom: cue.zoom,
        transition_ms: cue.transition_ms,
      },
    };
  }
  if (cue.type === "camera.focus_anchor") {
    return {
      kind: "camera",
      cue: {
        type: cue.type,
        anchor_id: cue.anchor_id,
        zoom: cue.zoom,
        transition_ms: cue.transition_ms,
      },
    };
  }
  if (cue.type === "camera.focus_zone") {
    return {
      kind: "camera",
      cue: {
        type: cue.type,
        zone_id: cue.zone_id,
        zoom: cue.zoom,
        transition_ms: cue.transition_ms,
      },
    };
  }
  if (cue.type === "camera.follow_actor" || cue.type === "camera.focus_actor") {
    return {
      kind: "camera",
      cue: {
        type: cue.type,
        actor_id: requireActorId(cue.role_id, actorIdByRole),
        zoom: cue.zoom,
        transition_ms: cue.transition_ms,
      },
    };
  }

  const actorId = requireActorId(cue.role_id, actorIdByRole);
  const base = {
    id: cue.cue_id,
    actor_id: actorId,
    source: "script" as const,
    policy: "replace" as const,
  };
  if (cue.type === "actor.move_to") {
    return {
      kind: "command",
      command: {
        ...base,
        type: cue.type,
        policy: cue.policy,
        target:
          cue.target.type === "anchor"
            ? {
                type: "anchor",
                id: cue.target.anchor_id,
                ...(cue.target.slot_id === undefined
                  ? {}
                  : { slot_id: cue.target.slot_id }),
              }
            : {
                type: "actor",
                id: requireActorId(cue.target.role_id, actorIdByRole),
                distance_tiles: cue.target.distance_tiles,
                preferred_side: cue.target.preferred_side,
              },
      },
    };
  }
  if (cue.type === "actor.follow_activity_path") {
    return {
      kind: "command",
      command: {
        ...base,
        type: cue.type,
        policy: cue.policy,
        activity_path_id: cue.activity_path_id,
        cycles: cue.cycles,
      },
    };
  }
  if (cue.type === "actor.follow") {
    return {
      kind: "command",
      command: {
        ...base,
        type: cue.type,
        target_actor_id: requireActorId(cue.target_role_id, actorIdByRole),
        distance_tiles: cue.distance_tiles,
        preferred_side: cue.preferred_side,
      },
    };
  }
  if (cue.type === "actor.face") {
    return {
      kind: "command",
      command: { ...base, type: cue.type, facing: cue.facing },
    };
  }
  if (cue.type === "actor.face_actor") {
    return {
      kind: "command",
      command: {
        ...base,
        type: cue.type,
        target_actor_id: requireActorId(cue.target_role_id, actorIdByRole),
      },
    };
  }
  if (cue.type === "dialogue.say") {
    return {
      kind: "command",
      command: {
        ...base,
        type: cue.type,
        text: cue.text,
        ...(cue.duration_ms === undefined ? {} : { duration_ms: cue.duration_ms }),
      },
    };
  }
  return { kind: "command", command: { ...base, type: cue.type } };
}

function requireActorId(
  roleId: string,
  actorIdByRole: Readonly<Record<string, string>>,
): string {
  const actorId = actorIdByRole[roleId];
  if (!actorId) throw new Error(`No Stage actor is bound to performance role: ${roleId}`);
  return actorId;
}
