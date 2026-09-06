export interface LabelRect { x: number; y: number; width: number; height: number }
export interface PortalLabelPoint { id: string; x: number; y: number; width: number; height: number }

/** Place readable screen-space labels, keeping nearby exits and the minimap separate. */
export function layoutPortalLabels(
  points: PortalLabelPoint[],
  viewport: { width: number; height: number },
  reserved: LabelRect[] = [],
): Map<string, LabelRect> {
  const placements = new Map<string, LabelRect>();
  const occupied = [
    ...reserved,
    ...points.map((point) => ({ x: point.x - 9, y: point.y - 9, width: 18, height: 18 })),
  ];
  const margin = 6;
  for (const point of points) {
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) continue;
    const width = Math.min(point.width, viewport.width - margin * 2);
    const height = point.height;
    for (const gap of [16, 48, 80, 112, 144]) {
      const candidates = [
        { x: point.x - width / 2, y: point.y - height - gap },
        { x: point.x - width / 2, y: point.y + gap },
        { x: point.x - width - gap, y: point.y - height / 2 },
        { x: point.x + gap, y: point.y - height / 2 },
      ];
      const rect = candidates.map((candidate) => ({
        x: Math.max(margin, Math.min(candidate.x, viewport.width - width - margin)),
        y: Math.max(margin, Math.min(candidate.y, viewport.height - height - margin)),
        width, height,
      })).find((candidate) => !occupied.some((other) => overlaps(candidate, other)));
      if (!rect) continue;
      placements.set(point.id, rect);
      occupied.push(rect);
      break;
    }
  }
  return placements;
}

function overlaps(a: LabelRect, b: LabelRect): boolean {
  const gap = 5;
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
