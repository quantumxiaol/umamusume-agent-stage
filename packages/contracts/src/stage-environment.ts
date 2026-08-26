import { z } from "zod";

export const timeOfDaySchema = z.enum(["day", "evening", "night"]);
export const stageWeatherSchema = z.enum(["clear", "rain", "snow"]);

export const stageEnvironmentSchema = z.object({
  schema_version: z.literal("stage_environment.v1").default("stage_environment.v1"),
  time_of_day: timeOfDaySchema.default("day"),
  weather: stageWeatherSchema.default("clear"),
  intensity: z.number().min(0).max(1).default(0.55),
  transition_ms: z.number().int().min(0).max(10_000).default(800),
});

export type TimeOfDay = z.infer<typeof timeOfDaySchema>;
export type StageWeather = z.infer<typeof stageWeatherSchema>;
export type StageEnvironment = z.infer<typeof stageEnvironmentSchema>;
