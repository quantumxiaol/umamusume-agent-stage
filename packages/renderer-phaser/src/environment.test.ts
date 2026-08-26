import { describe, expect, it } from "vitest";

import { interpolateEnvironmentVisual, resolveEnvironmentVisual } from "./environment";

describe("resolveEnvironmentVisual", () => {
  it("leaves clear daytime unobscured", () => {
    expect(
      resolveEnvironmentVisual({
        schema_version: "stage_environment.v1",
        time_of_day: "day",
        weather: "clear",
        intensity: 0.55,
        transition_ms: 800,
      }),
    ).toMatchObject({ shadeAlpha: 0, particleCount: 0 });
  });

  it("adds a dark shade and deterministic rain density at night", () => {
    const visual = resolveEnvironmentVisual({
      schema_version: "stage_environment.v1",
      time_of_day: "night",
      weather: "rain",
      intensity: 0.75,
      transition_ms: 800,
    });
    expect(visual.shadeAlpha).toBeGreaterThan(0.46);
    expect(visual.particleCount).toBe(87);
    expect(visual.particleAlpha).toBeGreaterThan(0.6);
  });

  it("interpolates the shade while switching particles to the target preset", () => {
    const visual = interpolateEnvironmentVisual(
      { shadeColor: 0xffffff, shadeAlpha: 0, particleColor: 0xffffff, particleAlpha: 0, particleCount: 0 },
      { shadeColor: 0x000000, shadeAlpha: 0.5, particleColor: 0xaabbcc, particleAlpha: 0.8, particleCount: 40 },
      0.5,
    );
    expect(visual.shadeColor).toBe(0x808080);
    expect(visual.shadeAlpha).toBe(0.25);
    expect(visual.particleCount).toBe(40);
  });
});
