import { describe, expect, it } from "vitest";

import { performanceCueSchema } from "@uma-stage/contracts";

import { compilePerformanceCue } from "./performance-compiler";

const bindings = { trainer: "trainer", vega: "uma_admire_vega" };

describe("compilePerformanceCue", () => {
  it("resolves role-based actor targets into Stage actor IDs", () => {
    const cue = performanceCueSchema.parse({
      cue_id: "approach",
      type: "actor.move_to",
      role_id: "vega",
      target: { type: "actor", role_id: "trainer", distance_tiles: 2 },
    });

    expect(compilePerformanceCue(cue, bindings)).toEqual({
      kind: "command",
      command: {
        id: "approach",
        type: "actor.move_to",
        actor_id: "uma_admire_vega",
        source: "script",
        policy: "replace",
        target: { type: "actor", id: "trainer", distance_tiles: 2 },
      },
    });
  });

  it("resolves camera roles without creating a Stage command", () => {
    const cue = performanceCueSchema.parse({
      cue_id: "close_up",
      type: "camera.focus_actor",
      role_id: "vega",
    });

    expect(compilePerformanceCue(cue, bindings)).toEqual({
      kind: "camera",
      cue: {
        type: "camera.focus_actor",
        actor_id: "uma_admire_vega",
        zoom: 0.8,
      },
    });
  });

  it("fails closed when a role has no live actor binding", () => {
    const cue = performanceCueSchema.parse({
      cue_id: "missing",
      type: "actor.stop",
      role_id: "unknown",
    });
    expect(() => compilePerformanceCue(cue, bindings)).toThrow(
      "No Stage actor is bound",
    );
  });
});
