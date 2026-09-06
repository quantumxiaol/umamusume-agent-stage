import { describe, expect, it } from "vitest";
import { layoutPortalLabels, type LabelRect } from "./portal-labels";

function intersects(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("portal destination labels", () => {
  it("keeps adjacent gate exits distinct and within the screen", () => {
    const points = [
      { id: "racecourse", x: 940, y: 340, width: 180, height: 28 },
      { id: "riverside", x: 940, y: 390, width: 150, height: 28 },
      { id: "top", x: 8, y: 8, width: 160, height: 28 },
      { id: "bottom", x: 8, y: 538, width: 160, height: 28 },
    ];
    const labels = layoutPortalLabels(points, { width: 960, height: 540 });
    expect(labels.size).toBe(4);
    const rectangles = [...labels.values()];
    for (const [index, rect] of rectangles.entries()) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(960);
      expect(rect.y + rect.height).toBeLessThanOrEqual(540);
      for (const other of rectangles.slice(index + 1)) expect(intersects(rect, other)).toBe(false);
      for (const point of points) expect(intersects(rect, { x: point.x - 9, y: point.y - 9, width: 18, height: 18 })).toBe(false);
    }
  });

  it("avoids the minimap and omits offscreen destinations", () => {
    const minimap = { x: 722, y: 16, width: 222, height: 150 };
    const labels = layoutPortalLabels([
      { id: "visible", x: 940, y: 100, width: 180, height: 28 },
      { id: "offscreen", x: 1000, y: 100, width: 180, height: 28 },
    ], { width: 960, height: 540 }, [minimap]);
    expect(labels.has("offscreen")).toBe(false);
    expect(labels.has("visible")).toBe(true);
    expect(intersects(labels.get("visible")!, minimap)).toBe(false);
  });
});
