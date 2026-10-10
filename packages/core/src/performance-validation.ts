import type { PerformanceScript, ScenePack } from "@uma-stage/contracts";

/** Resolve content references before a show takes over the live world. */
export function validatePerformanceScene(
  performanceScene: PerformanceScript["scenes"][number],
  scene: ScenePack,
): void {
  const fail = (where: string, message: string): never => {
    throw new Error(`${performanceScene.scene_id}/${where}: ${message}`);
  };
  for (const placement of performanceScene.placements) {
    if (placement.spawn_id && !scene.spawns.some((spawn) => spawn.id === placement.spawn_id)) {
      fail(placement.role_id, `Unknown spawn: ${placement.spawn_id}`);
    }
  }
  for (const beat of performanceScene.beats) {
    if (beat.cues.filter((cue) => cue.type.startsWith("camera.")).length > 1) {
      fail(beat.beat_id, "Only one camera cue may own the camera in a beat");
    }
    for (const cue of beat.cues) {
      const where = `${beat.beat_id}/${cue.cue_id}`;
      if (cue.type === "actor.move_to" && cue.target.type === "anchor") {
        const { anchor_id: anchorId, slot_id: slotId } = cue.target;
        const anchor = scene.anchors.find((candidate) => candidate.id === anchorId);
        if (!anchor) fail(where, `Unknown anchor: ${anchorId}`);
        if (slotId && !anchor?.slots.some((slot) => slot.id === slotId)) fail(where, `Unknown slot: ${anchorId}/${slotId}`);
      }
      if (cue.type === "actor.follow_activity_path" && !scene.activity_paths.some((path) => path.id === cue.activity_path_id)) {
        fail(where, `Unknown activity path: ${cue.activity_path_id}`);
      }
      if (cue.type === "camera.focus_anchor" && !scene.anchors.some((anchor) => anchor.id === cue.anchor_id)) {
        fail(where, `Unknown camera anchor: ${cue.anchor_id}`);
      }
      if (cue.type === "camera.focus_zone" && !scene.zones.some((zone) => zone.id === cue.zone_id)) {
        fail(where, `Unknown camera zone: ${cue.zone_id}`);
      }
    }
  }
}
