import {
  scenePackSchema,
  type Direction,
  type ScenePack,
  type TileBounds,
  type TilePosition,
} from "@uma-stage/contracts";

import type { TiledLayer, TiledMap, TiledObject, TiledPoint } from "./tiled-types";

export interface CompileSceneOptions {
  sceneId: string;
  displayName: string;
  description?: string;
  tiledSource?: string;
  backgroundColor?: string;
}

const directions = new Set<Direction>(["down", "left", "right", "up"]);

export function compileTiledScene(map: TiledMap, options: CompileSceneOptions): ScenePack {
  validateMapShape(map);
  const tileSize = map.tilewidth;
  const blockedTiles = exportBlockedTiles(map, tileSize);
  const anchors = exportAnchors(map, tileSize);
  attachAnchorSlots(anchors, map, tileSize);

  const candidate = scenePackSchema.parse({
    schema_version: "scene_pack.v1",
    scene_id: options.sceneId,
    display_name: options.displayName,
    description: options.description ?? propertyMap(map).description ?? "",
    map: {
      tile_size: tileSize,
      width: map.width,
      height: map.height,
      background_color:
        options.backgroundColor ?? stringProperty(propertyMap(map).background_color) ?? "#6f9f75",
      tiled_source: options.tiledSource,
    },
    navigation: { blocked_tiles: blockedTiles },
    zones: objectLayer(map, "zones").map((object) => {
      const properties = propertyMap(object);
      const id = requiredObjectId(object, properties);
      return {
        id,
        display_name: stringProperty(properties.display_name) ?? id,
        type: stringProperty(properties.zone_type) ?? "",
        description: stringProperty(properties.description) ?? "",
        bounds: objectBounds(object, tileSize),
        tags: csvList(properties.tags),
      };
    }),
    surfaces: objectLayer(map, "surfaces").map((object) => {
      const properties = propertyMap(object);
      return {
        id: requiredObjectId(object, properties),
        kind: stringProperty(properties.kind) ?? "grass",
        bounds: objectBounds(object, tileSize),
      };
    }),
    props: objectLayer(map, "props").map((object) => {
      const properties = propertyMap(object);
      return {
        id: requiredObjectId(object, properties),
        kind: stringProperty(properties.kind) ?? "sign",
        bounds: objectBounds(object, tileSize),
        label: stringProperty(properties.label),
        y_sort: booleanProperty(properties.y_sort),
      };
    }),
    anchors,
    spawns: objectLayer(map, "spawn_points").map((object) => {
      const properties = propertyMap(object);
      return {
        id: requiredObjectId(object, properties),
        position: objectTile(object, tileSize),
        facing: directionProperty(properties.facing) ?? "down",
      };
    }),
    portals: objectLayer(map, "portals").map((object) => {
      const properties = propertyMap(object);
      return {
        id: requiredObjectId(object, properties),
        position: objectTile(object, tileSize),
        target_scene_id: requiredStringProperty(properties.target_scene_id, "target_scene_id"),
        target_spawn_id: requiredStringProperty(properties.target_spawn_id, "target_spawn_id"),
      };
    }),
    activity_paths: objectLayer(map, "activity_paths").map((object) => {
      const properties = propertyMap(object);
      return {
        id: requiredObjectId(object, properties),
        activity_id: requiredStringProperty(properties.activity_id, "activity_id"),
        anchor_id: stringProperty(properties.anchor_id),
        loop: booleanProperty(properties.loop),
        points: polylineTiles(object, tileSize),
      };
    }),
  });

  validateSceneSemantics(candidate);
  return candidate;
}

function validateMapShape(map: TiledMap): void {
  if (map.orientation && map.orientation !== "orthogonal") {
    throw new Error(`Only orthogonal maps are supported, got ${map.orientation}`);
  }
  if (map.tilewidth !== map.tileheight) {
    throw new Error("ScenePack v1 requires square navigation tiles");
  }
  if (map.width <= 0 || map.height <= 0 || map.tilewidth <= 0) {
    throw new Error("Tiled map dimensions must be positive");
  }
}

function exportBlockedTiles(map: TiledMap, tileSize: number): TilePosition[] {
  const blocked = new Set<string>();
  for (const object of objectLayer(map, "collision")) {
    const tiles = object.polygon
      ? rasterizePolygon(object, tileSize)
      : rasterizeRectangle(object, tileSize);
    for (const tile of tiles) blocked.add(tileKey(tile));
  }
  return [...blocked]
    .map(positionOf)
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

function exportAnchors(map: TiledMap, tileSize: number) {
  return objectLayer(map, "anchors").map((object) => {
    const properties = propertyMap(object);
    const id = requiredObjectId(object, properties);
    return {
      id,
      display_name: stringProperty(properties.display_name) ?? id,
      description: stringProperty(properties.description) ?? "",
      position: objectTile(object, tileSize),
      facing: directionProperty(properties.facing),
      tags: csvList(properties.tags),
      slots: [] as Array<{ id: string; position: TilePosition; facing?: Direction }>,
      interactions: csvList(properties.interactions),
    };
  });
}

function attachAnchorSlots(
  anchors: ReturnType<typeof exportAnchors>,
  map: TiledMap,
  tileSize: number,
): void {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  for (const object of objectLayer(map, "anchor_slots")) {
    const properties = propertyMap(object);
    const anchorId = requiredStringProperty(properties.anchor_id, "anchor_id");
    const anchor = byId.get(anchorId);
    if (!anchor) throw new Error(`Anchor slot references unknown anchor: ${anchorId}`);
    const facing = directionProperty(properties.facing);
    anchor.slots.push({
      id: stringProperty(properties.slot_id) ?? object.name ?? `slot_${anchor.slots.length + 1}`,
      position: objectTile(object, tileSize),
      ...(facing ? { facing } : {}),
    });
  }
}

function validateSceneSemantics(scene: ScenePack): void {
  const blocked = new Set(scene.navigation.blocked_tiles.map(tileKey));
  const ids = new Set<string>();
  const register = (id: string, label: string) => {
    if (ids.has(`${label}:${id}`)) throw new Error(`Duplicate ${label} id: ${id}`);
    ids.add(`${label}:${id}`);
  };

  scene.zones.forEach((zone) => {
    register(zone.id, "zone");
    assertBounds(zone.bounds, scene, `zone ${zone.id}`);
  });
  scene.surfaces.forEach((surface) => {
    register(surface.id, "surface");
    assertBounds(surface.bounds, scene, `surface ${surface.id}`);
  });
  scene.props.forEach((prop) => {
    register(prop.id, "prop");
    assertBounds(prop.bounds, scene, `prop ${prop.id}`);
  });
  scene.navigation.blocked_tiles.forEach((tile) => assertTile(tile, scene, "blocked tile"));

  const navigablePoints: Array<{ position: TilePosition; label: string }> = [];
  scene.anchors.forEach((anchor) => {
    register(anchor.id, "anchor");
    assertUnblocked(anchor.position, scene, blocked, `anchor ${anchor.id}`);
    navigablePoints.push({ position: anchor.position, label: `anchor ${anchor.id}` });
    const slotIds = new Set<string>();
    anchor.slots.forEach((slot) => {
      if (slotIds.has(slot.id)) throw new Error(`Duplicate slot id for ${anchor.id}: ${slot.id}`);
      slotIds.add(slot.id);
      assertUnblocked(slot.position, scene, blocked, `slot ${anchor.id}/${slot.id}`);
      navigablePoints.push({ position: slot.position, label: `slot ${anchor.id}/${slot.id}` });
    });
  });
  scene.spawns.forEach((spawn) => {
    register(spawn.id, "spawn");
    assertUnblocked(spawn.position, scene, blocked, `spawn ${spawn.id}`);
    navigablePoints.push({ position: spawn.position, label: `spawn ${spawn.id}` });
  });
  scene.portals.forEach((portal) => {
    register(portal.id, "portal");
    assertUnblocked(portal.position, scene, blocked, `portal ${portal.id}`);
    navigablePoints.push({ position: portal.position, label: `portal ${portal.id}` });
  });
  scene.activity_paths.forEach((path) => {
    register(path.id, "activity path");
    if (path.anchor_id && !scene.anchors.some((anchor) => anchor.id === path.anchor_id)) {
      throw new Error(`Activity path references unknown anchor: ${path.id} -> ${path.anchor_id}`);
    }
    path.points.forEach((point) =>
      assertUnblocked(point, scene, blocked, `activity path ${path.id}`),
    );
  });

  assertConnected(navigablePoints, scene, blocked);
}

function assertConnected(
  points: Array<{ position: TilePosition; label: string }>,
  scene: ScenePack,
  blocked: Set<string>,
): void {
  const start = scene.spawns[0]?.position ?? points[0]?.position;
  if (!start) return;
  const visited = new Set([tileKey(start)]);
  const queue = [start];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (!current) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = tileKey(next);
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= scene.map.width ||
        next.y >= scene.map.height ||
        blocked.has(key) ||
        visited.has(key)
      ) continue;
      visited.add(key);
      queue.push(next);
    }
  }
  const unreachable = points.find((point) => !visited.has(tileKey(point.position)));
  if (unreachable) throw new Error(`${unreachable.label} is unreachable from the primary spawn`);
}

function assertTile(position: TilePosition, scene: ScenePack, label: string): void {
  if (position.x >= scene.map.width || position.y >= scene.map.height) {
    throw new Error(`${label} is out of bounds: ${position.x}, ${position.y}`);
  }
}

function assertUnblocked(
  position: TilePosition,
  scene: ScenePack,
  blocked: Set<string>,
  label: string,
): void {
  assertTile(position, scene, label);
  if (blocked.has(tileKey(position))) {
    throw new Error(`${label} lands on a blocked tile: ${position.x}, ${position.y}`);
  }
}

function assertBounds(bounds: TileBounds, scene: ScenePack, label: string): void {
  if (bounds.x + bounds.width > scene.map.width || bounds.y + bounds.height > scene.map.height) {
    throw new Error(`${label} is out of bounds`);
  }
}

function objectLayer(map: TiledMap, name: string): TiledObject[] {
  const layers = flattenLayers(map.layers);
  const layer = layers.find((candidate) => candidate.name === name);
  return layer?.type === "objectgroup" ? (layer.objects ?? []) : [];
}

function flattenLayers(layers: TiledLayer[]): TiledLayer[] {
  return layers.flatMap((layer) => [layer, ...(layer.layers ? flattenLayers(layer.layers) : [])]);
}

function propertyMap(value: { properties?: Array<{ name: string; value: unknown }> }): Record<string, unknown> {
  return Object.fromEntries((value.properties ?? []).map((property) => [property.name, property.value]));
}

function requiredObjectId(object: TiledObject, properties: Record<string, unknown>): string {
  const id = object.name?.trim() || stringProperty(properties.id);
  if (!id) throw new Error(`Tiled object ${object.id ?? "?"} requires a name or id property`);
  return id;
}

function requiredStringProperty(value: unknown, name: string): string {
  const result = stringProperty(value);
  if (!result) throw new Error(`Missing required Tiled property: ${name}`);
  return result;
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanProperty(value: unknown): boolean {
  return value === true || value === "true";
}

function directionProperty(value: unknown): Direction | undefined {
  const text = stringProperty(value) as Direction | undefined;
  if (!text) return undefined;
  if (!directions.has(text)) throw new Error(`Unsupported direction: ${text}`);
  return text;
}

function csvList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function objectTile(object: TiledObject, tileSize: number): TilePosition {
  let x = object.x ?? 0;
  let y = object.y ?? 0;
  if (!object.point && object.width && object.height) {
    x += object.width / 2;
    y += object.height / 2;
  }
  return { x: Math.floor(x / tileSize), y: Math.floor(y / tileSize) };
}

function objectBounds(object: TiledObject, tileSize: number): TileBounds {
  return {
    x: Math.floor((object.x ?? 0) / tileSize),
    y: Math.floor((object.y ?? 0) / tileSize),
    width: Math.max(1, Math.ceil((object.width ?? tileSize) / tileSize)),
    height: Math.max(1, Math.ceil((object.height ?? tileSize) / tileSize)),
  };
}

function rasterizeRectangle(object: TiledObject, tileSize: number): TilePosition[] {
  const x0 = Math.floor((object.x ?? 0) / tileSize);
  const y0 = Math.floor((object.y ?? 0) / tileSize);
  const x1 = Math.ceil(((object.x ?? 0) + (object.width ?? tileSize)) / tileSize);
  const y1 = Math.ceil(((object.y ?? 0) + (object.height ?? tileSize)) / tileSize);
  const result: TilePosition[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) result.push({ x, y });
  }
  return result;
}

function rasterizePolygon(object: TiledObject, tileSize: number): TilePosition[] {
  const originX = object.x ?? 0;
  const originY = object.y ?? 0;
  const polygon = (object.polygon ?? []).map((point) => ({
    x: originX + point.x,
    y: originY + point.y,
  }));
  if (!polygon.length) return [];
  const minX = Math.floor(Math.min(...polygon.map((point) => point.x)) / tileSize);
  const maxX = Math.ceil(Math.max(...polygon.map((point) => point.x)) / tileSize);
  const minY = Math.floor(Math.min(...polygon.map((point) => point.y)) / tileSize);
  const maxY = Math.ceil(Math.max(...polygon.map((point) => point.y)) / tileSize);
  const result: TilePosition[] = [];
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      if (pointInPolygon({ x: (x + 0.5) * tileSize, y: (y + 0.5) * tileSize }, polygon)) {
        result.push({ x, y });
      }
    }
  }
  return result;
}

function pointInPolygon(point: TiledPoint, polygon: TiledPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (!currentPoint || !previousPoint) continue;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polylineTiles(object: TiledObject, tileSize: number): TilePosition[] {
  const points = object.polyline ?? object.polygon ?? [];
  const seen = new Set<string>();
  const result: TilePosition[] = [];
  for (const point of points) {
    const tile = {
      x: Math.floor(((object.x ?? 0) + point.x) / tileSize),
      y: Math.floor(((object.y ?? 0) + point.y) / tileSize),
    };
    const key = tileKey(tile);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tile);
    }
  }
  return result;
}

function tileKey(position: TilePosition): string {
  return `${position.x},${position.y}`;
}

function positionOf(key: string): TilePosition {
  const [x, y] = key.split(",").map(Number);
  if (x === undefined || y === undefined) throw new Error(`Invalid tile key: ${key}`);
  return { x, y };
}
