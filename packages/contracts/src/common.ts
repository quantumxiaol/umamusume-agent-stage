import { z } from "zod";

export const directionSchema = z.enum(["down", "left", "right", "up"]);
export type Direction = z.infer<typeof directionSchema>;

export const tilePositionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export type TilePosition = z.infer<typeof tilePositionSchema>;

export const worldPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type WorldPosition = z.infer<typeof worldPositionSchema>;

export const tileBoundsSchema = tilePositionSchema.extend({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TileBounds = z.infer<typeof tileBoundsSchema>;

export const controlOwnerSchema = z.enum(["player", "agent", "script", "system"]);
export type ControlOwner = z.infer<typeof controlOwnerSchema>;

export const commandPolicySchema = z.enum(["reject", "queue", "replace"]);
export type CommandPolicy = z.infer<typeof commandPolicySchema>;
