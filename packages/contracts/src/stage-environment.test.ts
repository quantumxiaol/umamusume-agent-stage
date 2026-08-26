import { describe, expect, it } from "vitest";

import { stageEnvironmentSchema } from "./stage-environment";

describe("stageEnvironmentSchema", () => {
  it("provides a neutral daytime default", () => {
    expect(stageEnvironmentSchema.parse({})).toEqual({
      schema_version: "stage_environment.v1",
      time_of_day: "day",
      weather: "clear",
      intensity: 0.55,
      transition_ms: 800,
    });
  });

  it("accepts lightweight night weather without changing scene identity", () => {
    expect(
      stageEnvironmentSchema.parse({
        time_of_day: "night",
        weather: "rain",
        intensity: 0.7,
        transition_ms: 1200,
      }),
    ).toMatchObject({
      time_of_day: "night",
      weather: "rain",
      intensity: 0.7,
      transition_ms: 1200,
    });
  });
});
