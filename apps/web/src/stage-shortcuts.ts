export type StageShortcut = "toggle-minimap" | "toggle-overview" | "open-world";

export interface StageShortcutInput {
  key: string;
  enabled: boolean;
  editing: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function resolveStageShortcut(input: StageShortcutInput): StageShortcut | null {
  if (
    !input.enabled ||
    input.editing ||
    input.defaultPrevented ||
    input.repeat ||
    input.ctrlKey ||
    input.metaKey ||
    input.altKey
  ) return null;
  const key = input.key.toLowerCase();
  if (key === "m") return "toggle-minimap";
  if (key === "o") return "toggle-overview";
  if (key === "g") return "open-world";
  return null;
}
