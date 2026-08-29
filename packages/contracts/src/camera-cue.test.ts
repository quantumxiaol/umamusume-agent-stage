import { describe, expect, it } from "vitest";

import { cameraCueSchema } from "./camera-cue";

describe("cameraCueSchema", () => {
  it("defaults camera changes to a smooth transition", () => {
    expect(
      cameraCueSchema.parse({
        type: "camera.focus_actor",
        actor_id: "uma_admire_vega",
      }),
    ).toMatchObject({ zoom: 0.8, transition_ms: 450 });
  });

  it("allows an intentional hard cut", () => {
    expect(
      cameraCueSchema.parse({
        type: "camera.overview",
        transition_ms: 0,
      }),
    ).toEqual({ type: "camera.overview", transition_ms: 0 });
  });
});
