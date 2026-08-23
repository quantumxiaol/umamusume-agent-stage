import type { ScenePack, TilePosition } from "@uma-stage/contracts";

export interface PathQueryOptions {
  isOccupied?: (position: TilePosition) => boolean;
}

export interface NearestTileOptions extends PathQueryOptions {
  from?: TilePosition;
  maxRadius?: number;
}

const cardinalDirections = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const;

export class GridNavigation {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly #blocked: Set<string>;

  constructor(scene: ScenePack) {
    this.width = scene.map.width;
    this.height = scene.map.height;
    this.tileSize = scene.map.tile_size;
    this.#blocked = new Set(scene.navigation.blocked_tiles.map(tileKey));
  }

  isWalkable(position: TilePosition): boolean {
    return (
      position.x >= 0 &&
      position.y >= 0 &&
      position.x < this.width &&
      position.y < this.height &&
      !this.#blocked.has(tileKey(position))
    );
  }

  findPath(
    from: TilePosition,
    to: TilePosition,
    options: PathQueryOptions = {},
  ): TilePosition[] {
    if (sameTile(from, to)) return [];
    if (!this.isAvailable(to, options)) return [];

    const startKey = tileKey(from);
    const targetKey = tileKey(to);
    const open = new Map<string, { position: TilePosition; f: number }>([
      [startKey, { position: from, f: manhattan(from, to) }],
    ]);
    const closed = new Set<string>();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[startKey, 0]]);

    while (open.size > 0) {
      const currentEntry = [...open.entries()].reduce((best, candidate) =>
        candidate[1].f < best[1].f ? candidate : best,
      );
      const [currentKey, current] = currentEntry;
      open.delete(currentKey);
      if (currentKey === targetKey) return reconstructPath(targetKey, startKey, cameFrom);
      closed.add(currentKey);

      for (const direction of cardinalDirections) {
        const next = {
          x: current.position.x + direction.x,
          y: current.position.y + direction.y,
        };
        const nextKey = tileKey(next);
        if (closed.has(nextKey) || !this.isAvailable(next, options)) continue;

        const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + 1;
        if (tentative >= (gScore.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
        cameFrom.set(nextKey, currentKey);
        gScore.set(nextKey, tentative);
        open.set(nextKey, { position: next, f: tentative + manhattan(next, to) });
      }
    }
    return [];
  }

  findNearestAvailable(target: TilePosition, options: NearestTileOptions = {}): TilePosition | null {
    const maxRadius = options.maxRadius ?? 4;
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (const candidate of tilesAtManhattanRadius(target, radius)) {
        if (!this.isAvailable(candidate, options)) continue;
        if (options.from && !sameTile(options.from, candidate)) {
          const path = this.findPath(options.from, candidate, options);
          if (path.length === 0) continue;
        }
        return candidate;
      }
    }
    return null;
  }

  worldToTile(position: { x: number; y: number }): TilePosition {
    return {
      x: Math.floor(position.x / this.tileSize),
      y: Math.floor(position.y / this.tileSize),
    };
  }

  tileToWorld(position: TilePosition): { x: number; y: number } {
    return {
      x: (position.x + 0.5) * this.tileSize,
      y: (position.y + 0.5) * this.tileSize,
    };
  }

  private isAvailable(position: TilePosition, options: PathQueryOptions): boolean {
    return this.isWalkable(position) && !options.isOccupied?.(position);
  }
}

export function tilesAtManhattanRadius(center: TilePosition, radius: number): TilePosition[] {
  if (radius === 0) return [center];
  const result: TilePosition[] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    const dy = radius - Math.abs(dx);
    result.push({ x: center.x + dx, y: center.y + dy });
    if (dy !== 0) result.push({ x: center.x + dx, y: center.y - dy });
  }
  return result;
}

export function tileKey(position: TilePosition): string {
  return `${position.x},${position.y}`;
}

function sameTile(left: TilePosition, right: TilePosition): boolean {
  return left.x === right.x && left.y === right.y;
}

function manhattan(left: TilePosition, right: TilePosition): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function reconstructPath(
  targetKey: string,
  startKey: string,
  cameFrom: Map<string, string>,
): TilePosition[] {
  const result: TilePosition[] = [];
  let current = targetKey;
  while (current !== startKey) {
    result.push(positionOf(current));
    const previous = cameFrom.get(current);
    if (!previous) return [];
    current = previous;
  }
  return result.reverse();
}

function positionOf(key: string): TilePosition {
  const [x, y] = key.split(",").map(Number);
  if (x === undefined || y === undefined) throw new Error(`Invalid tile key: ${key}`);
  return { x, y };
}
