export interface TiledProperty {
  name: string;
  value: unknown;
}

export interface TiledPoint {
  x: number;
  y: number;
}

export interface TiledObject {
  id?: number;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  point?: boolean;
  polygon?: TiledPoint[];
  polyline?: TiledPoint[];
  properties?: TiledProperty[];
}

export interface TiledLayer {
  name: string;
  type: "objectgroup" | "group" | "tilelayer" | "imagelayer";
  layers?: TiledLayer[];
  objects?: TiledObject[];
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  orientation?: string;
  layers: TiledLayer[];
  properties?: TiledProperty[];
}
