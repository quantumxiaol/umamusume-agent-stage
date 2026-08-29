import { describe, expect, it } from "vitest";

import { resolveStageShortcut } from "./stage-shortcuts";

describe("resolveStageShortcut", () => {
  it("maps M and O without depending on letter case", () => {
    expect(resolveStageShortcut({ key: "m", enabled: true, editing: false }))
      .toBe("toggle-minimap");
    expect(resolveStageShortcut({ key: "O", enabled: true, editing: false }))
      .toBe("toggle-overview");
  });

  it("does not intercept typing, modifiers, repeats, or a disabled stage", () => {
    expect(resolveStageShortcut({ key: "m", enabled: true, editing: true })).toBeNull();
    expect(resolveStageShortcut({ key: "o", enabled: false, editing: false })).toBeNull();
    expect(resolveStageShortcut({
      key: "m",
      enabled: true,
      editing: false,
      ctrlKey: true,
    })).toBeNull();
    expect(resolveStageShortcut({
      key: "o",
      enabled: true,
      editing: false,
      repeat: true,
    })).toBeNull();
  });
});
