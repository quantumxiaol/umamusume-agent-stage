import Phaser from "phaser";

import type {
  ActorLocomotion,
  CameraCue,
  CharacterPack,
  Direction,
  ScenePack,
  StageActorState,
} from "@uma-stage/contracts";
import type { StageRuntime } from "@uma-stage/core";

export interface ActorViewConfig {
  actorId: string;
  pack: CharacterPack;
  bundleBaseUrl: string;
}

export interface StageRendererOptions {
  parent: HTMLElement;
  runtime: StageRuntime;
  scene: ScenePack;
  sceneBaseUrl: string;
  actors: ActorViewConfig[];
  playerActorId?: string;
  debug?: boolean;
}

export interface StageCameraState {
  cue: CameraCue;
  center: { x: number; y: number };
  zoom: number;
}

export interface StageGameController {
  destroy(removeCanvas?: boolean): void;
  setCameraCue(cue: CameraCue): void;
  cameraState(): StageCameraState | null;
}

interface ActorDisplay {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  bubble: Phaser.GameObjects.Text;
  config: ActorViewConfig;
  lastAnimation: string;
}

interface ResolvedAnimation {
  state: ActorLocomotion;
  frames: string[];
  fps: number;
  loop: boolean;
}

const surfaceColors: Record<ScenePack["surfaces"][number]["kind"], number> = {
  grass: 0x76a97a,
  path: 0xd9c99b,
  plaza: 0xcdbc8b,
  track: 0xb97b66,
  water: 0x6aa8bb,
  floor: 0xc9c4b6,
};

class RuntimeScene extends Phaser.Scene {
  readonly #options: StageRendererOptions;
  readonly #displays = new Map<string, ActorDisplay>();
  #movementKeys: Record<string, Phaser.Input.Keyboard.Key> | null = null;
  #cameraCue: CameraCue;
  #minimap: Phaser.Cameras.Scene2D.Camera | null = null;
  #minimapViewport: Phaser.GameObjects.Graphics | null = null;
  #minimapFrame: Phaser.GameObjects.Graphics | null = null;

  constructor(options: StageRendererOptions) {
    super({ key: "uma-stage-runtime" });
    this.#options = options;
    this.#cameraCue = {
      type: "camera.follow_actor",
      actor_id: options.playerActorId ?? options.actors[0]?.actorId ?? "stage",
      zoom: 0.8,
    };
  }

  preload(): void {
    const { tileset } = this.#options.scene;
    if (tileset) {
      this.load.spritesheet(mapTextureKey(this.#options.scene.scene_id), assetUrl(this.#options.sceneBaseUrl, tileset.image), {
        frameWidth: tileset.tile_width,
        frameHeight: tileset.tile_height,
      });
    }
    for (const actor of this.#options.actors) {
      this.load.atlas(
        textureKey(actor.actorId),
        assetUrl(actor.bundleBaseUrl, actor.pack.atlas.image),
        assetUrl(actor.bundleBaseUrl, actor.pack.atlas.data),
      );
    }
  }

  create(): void {
    this.drawMap();
    for (const actor of this.#options.actors) this.createActor(actor);
    this.#movementKeys =
      (this.input.keyboard?.addKeys(
        "W,A,S,D,UP,LEFT,DOWN,RIGHT",
      ) as Record<string, Phaser.Input.Keyboard.Key> | undefined) ?? null;
    this.game.canvas.tabIndex = 0;
    this.input.on("pointerdown", this.focusStageInput, this);
    this.createMinimap();
    this.scale.on("resize", this.handleResize, this);
    this.applyCameraCue();
  }

  override update(_time: number, delta: number): void {
    const playerActorId = this.#options.playerActorId;
    if (playerActorId) {
      const intent = this.readMovementIntent();
      this.#options.runtime.setPlayerIntent(playerActorId, intent.x, intent.y);
    }
    this.#options.runtime.tick(delta);
    for (const state of this.#options.runtime.snapshot().actors) this.syncActor(state);
    this.updateMinimapViewport();
  }

  private drawMap(): void {
    const { scene } = this.#options;
    const tileSize = scene.map.tile_size;
    const width = scene.map.width * tileSize;
    const height = scene.map.height * tileSize;
    this.cameras.main.setBackgroundColor(scene.map.background_color);

    const surfaces = this.add.graphics().setDepth(-1000);
    surfaces.fillStyle(parseColor(scene.map.background_color), 1).fillRect(0, 0, width, height);
    if (scene.tileset && scene.layers.length > 0) {
      const texture = mapTextureKey(scene.scene_id);
      for (const [index, layer] of scene.layers.entries()) {
        const rows = Array.from({ length: scene.map.height }, (_, row) =>
          layer.data.slice(row * scene.map.width, (row + 1) * scene.map.width),
        );
        const tilemap = this.make.tilemap({
          data: rows,
          tileWidth: scene.tileset.tile_width,
          tileHeight: scene.tileset.tile_height,
        });
        const tileset = tilemap.addTilesetImage(
          scene.tileset.id,
          texture,
          scene.tileset.tile_width,
          scene.tileset.tile_height,
          0,
          0,
          0,
        );
        if (!tileset) throw new Error(`Unable to bind tileset ${scene.tileset.id}`);
        tilemap.createLayer(0, tileset, 0, 0)?.setDepth(-990 + index);
      }
      for (const landmark of scene.landmarks) this.drawLandmark(landmark, tileSize);
      this.drawPortals();
    } else {
      for (const surface of scene.surfaces) {
        const bounds = pixelBounds(surface.bounds, tileSize);
        surfaces.fillStyle(surfaceColors[surface.kind], 1).fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        if (surface.kind === "track") {
          surfaces.lineStyle(4, 0xe9c6ab, 0.9).strokeRoundedRect(
            bounds.x + 8,
            bounds.y + 8,
            bounds.width - 16,
            bounds.height - 16,
            28,
          );
        }
      }
      for (const prop of scene.props) this.drawProp(prop, tileSize);
    }

    if (this.#options.debug || scene.layers.length === 0) {
      const grid = this.add.graphics().setDepth(-900);
      grid.lineStyle(1, 0x274c3d, 0.08);
      for (let x = 0; x <= width; x += tileSize) grid.lineBetween(x, 0, x, height);
      for (let y = 0; y <= height; y += tileSize) grid.lineBetween(0, y, width, y);
    }

    if (this.#options.debug) this.drawDebugOverlay();
  }

  setCameraCue(cue: CameraCue): void {
    this.#cameraCue = cue;
    if (this.sys.isActive()) this.applyCameraCue();
  }

  cameraState(): StageCameraState | null {
    if (!this.sys.isActive()) return null;
    return {
      cue: this.#cameraCue,
      center: { x: this.cameras.main.midPoint.x, y: this.cameras.main.midPoint.y },
      zoom: this.cameras.main.zoom,
    };
  }

  private drawLandmark(landmark: ScenePack["landmarks"][number], tileSize: number): void {
    if (landmark.render_mode === "tile_stamp") return;
    const bounds = pixelBounds(landmark.bounds, tileSize);
    const graphics = this.add.graphics().setDepth(-980);
    if (["track", "track_turf", "track_dirt"].includes(landmark.kind)) {
      const inset = landmark.kind === "track_turf" ? tileSize * 3 : tileSize * 4;
      graphics.lineStyle(4, 0xf5edd7, 0.9).strokeRoundedRect(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        Math.min(tileSize * 9, bounds.height / 2),
      );
      if (bounds.width > inset * 2 && bounds.height > inset * 2) {
        graphics.lineStyle(3, 0xf5edd7, 0.9).strokeRoundedRect(
          bounds.x + inset,
          bounds.y + inset,
          bounds.width - inset * 2,
          bounds.height - inset * 2,
          Math.max(8, Math.min(tileSize * 9, bounds.height / 2) - inset),
        );
      }
    } else if (landmark.kind === "track_straight") {
      graphics.lineStyle(4, 0xf5edd7, 0.9).strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      graphics.lineStyle(2, 0xf5edd7, 0.9);
      for (let lane = 1; lane < landmark.bounds.height; lane += 1) {
        graphics.lineBetween(bounds.x, bounds.y + lane * tileSize, bounds.x + bounds.width, bounds.y + lane * tileSize);
      }
    } else if (landmark.kind === "training_zone") {
      graphics.lineStyle(4, 0x8f673f).strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    } else if (landmark.kind === "building") {
      graphics.fillStyle(0xe4deca).fillRect(bounds.x, bounds.y + 20, bounds.width, bounds.height - 20);
      graphics.fillStyle(0x8f4b57).fillRect(bounds.x - 6, bounds.y, bounds.width + 12, 28);
      graphics.fillStyle(0x5b7987);
      for (let x = bounds.x + 28; x < bounds.x + bounds.width - 22; x += 58) {
        graphics.fillRect(x, bounds.y + 62, 28, 38);
      }
      graphics.fillStyle(0x745a48).fillRect(bounds.x + bounds.width / 2 - 18, bounds.y + bounds.height - 55, 36, 55);
    } else if (landmark.kind === "fountain") {
      graphics.fillStyle(0xded4bc).fillEllipse(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.68, bounds.width, bounds.height * 0.48);
      graphics.fillStyle(0x68aeba).fillEllipse(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.65, bounds.width - 18, bounds.height * 0.32);
      graphics.fillStyle(0xddd4bd).fillRect(bounds.x + bounds.width / 2 - 6, bounds.y + 20, 12, bounds.height * 0.48);
    } else if (landmark.kind === "entrance") {
      graphics.fillStyle(0xd8ccb1).fillRect(bounds.x + 5, bounds.y + 32, 26, bounds.height - 32);
      graphics.fillRect(bounds.x + bounds.width - 31, bounds.y + 32, 26, bounds.height - 32);
      graphics.fillStyle(0x6f8190).fillRect(bounds.x, bounds.y + 22, bounds.width, 24);
      graphics.fillStyle(0xefe3c5).fillRect(bounds.x + 8, bounds.y + 27, bounds.width - 16, 14);
    }
  }

  private drawPortals(): void {
    const { scene } = this.#options;
    const graphics = this.add.graphics().setDepth(20000);
    for (const portal of scene.portals) {
      const edge =
        portal.position.x === 0 ||
        portal.position.y === 0 ||
        portal.position.x === scene.map.width - 1 ||
        portal.position.y === scene.map.height - 1;
      const x = (portal.position.x + 0.5) * scene.map.tile_size;
      const y = (portal.position.y + 0.5) * scene.map.tile_size;
      graphics.fillStyle(edge ? 0x79d8f4 : 0xffd76b, 0.8).fillCircle(x, y, edge ? 8 : 7);
      graphics.lineStyle(1.5, 0xffffff, 0.7).strokeCircle(x, y, edge ? 8 : 7);
    }
  }

  private drawProp(prop: ScenePack["props"][number], tileSize: number): void {
    const bounds = pixelBounds(prop.bounds, tileSize);
    const graphics = this.add.graphics();
    const depth = prop.y_sort ? bounds.y + bounds.height : Math.max(10, bounds.y + bounds.height - 2);
    graphics.setDepth(depth);

    if (prop.kind === "building") {
      graphics.fillStyle(0xe7e0cc).fillRoundedRect(bounds.x, bounds.y + 12, bounds.width, bounds.height - 12, 6);
      graphics.fillStyle(0x8f4f57).fillRect(bounds.x - 5, bounds.y, bounds.width + 10, 24);
      graphics.fillStyle(0x577686);
      const windowY = bounds.y + 50;
      for (let x = bounds.x + 28; x < bounds.x + bounds.width - 24; x += 54) {
        graphics.fillRect(x, windowY, 24, 34);
      }
      graphics.fillStyle(0x765b48).fillRect(bounds.x + bounds.width / 2 - 18, bounds.y + bounds.height - 52, 36, 52);
    } else if (prop.kind === "tree") {
      graphics.fillStyle(0x465b3d).fillRect(bounds.x + bounds.width / 2 - 5, bounds.y + bounds.height / 2, 10, bounds.height / 2);
      graphics.fillStyle(0x315f46).fillCircle(bounds.x + bounds.width / 2, bounds.y + bounds.height / 3, bounds.width * 0.7);
      graphics.fillStyle(0x477b58, 0.85).fillCircle(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.28, bounds.width * 0.36);
    } else if (prop.kind === "fountain") {
      graphics.fillStyle(0xdfd5bb).fillEllipse(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.72, bounds.width, bounds.height * 0.46);
      graphics.fillStyle(0x6daab4).fillEllipse(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.68, bounds.width - 14, bounds.height * 0.3);
      graphics.fillStyle(0xd9d0b9).fillRect(bounds.x + bounds.width / 2 - 6, bounds.y + 12, 12, bounds.height * 0.55);
      graphics.fillStyle(0x91cad1, 0.8).fillCircle(bounds.x + bounds.width / 2, bounds.y + 15, 9);
    } else if (prop.kind === "bench") {
      graphics.fillStyle(0x71503e).fillRoundedRect(bounds.x, bounds.y + 7, bounds.width, bounds.height * 0.42, 3);
      graphics.fillRect(bounds.x + 5, bounds.y + bounds.height - 9, 5, 9);
      graphics.fillRect(bounds.x + bounds.width - 10, bounds.y + bounds.height - 9, 5, 9);
    } else if (prop.kind === "vending_machine") {
      graphics.fillStyle(0x466a7a).fillRoundedRect(bounds.x, bounds.y, bounds.width, bounds.height, 3);
      graphics.fillStyle(0xe9f2e9).fillRect(bounds.x + 5, bounds.y + 7, bounds.width - 10, bounds.height * 0.36);
      graphics.fillStyle(0xe58f69).fillRect(bounds.x + 7, bounds.y + bounds.height * 0.58, bounds.width - 14, 6);
    } else {
      graphics.fillStyle(0x6b5340).fillRect(bounds.x + bounds.width * 0.42, bounds.y + bounds.height * 0.35, bounds.width * 0.16, bounds.height * 0.65);
      graphics.fillStyle(0xd5c494).fillRoundedRect(bounds.x, bounds.y, bounds.width, bounds.height * 0.52, 3);
    }

    if (prop.label) {
      this.add
        .text(bounds.x + bounds.width / 2, bounds.y + 30, prop.label, {
          color: "#233830",
          fontFamily: "system-ui, sans-serif",
          fontSize: "12px",
          fontStyle: "bold",
        })
        .setOrigin(0.5)
        .setDepth(depth + 0.1);
    }
  }

  private drawDebugOverlay(): void {
    const tileSize = this.#options.scene.map.tile_size;
    const graphics = this.add.graphics().setDepth(50000);
    graphics.fillStyle(0xe65f5c, 0.28);
    for (const tile of this.#options.scene.navigation.blocked_tiles) {
      graphics.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    }
    graphics.fillStyle(0x2fcb8b, 0.7);
    for (const anchor of this.#options.scene.anchors) {
      graphics.fillCircle((anchor.position.x + 0.5) * tileSize, (anchor.position.y + 0.5) * tileSize, 5);
      for (const slot of anchor.slots) {
        graphics.fillCircle((slot.position.x + 0.5) * tileSize, (slot.position.y + 0.5) * tileSize, 3);
      }
    }
  }

  private createActor(config: ActorViewConfig): void {
    this.registerAnimations(config);
    const state = this.#options.runtime.snapshot().actors.find((candidate) => candidate.actor_id === config.actorId);
    if (!state) throw new Error(`Renderer actor has not been spawned: ${config.actorId}`);
    const firstFrame = config.pack.animations.stand.directions[state.facing][0];
    if (!firstFrame) throw new Error(`Missing stand frame for ${config.actorId}/${state.facing}`);

    const sprite = this.add.sprite(state.position.x, state.position.y, textureKey(config.actorId), firstFrame);
    sprite
      .setOrigin(
        config.pack.render.anchor_x / config.pack.render.frame_width,
        config.pack.render.anchor_y / config.pack.render.frame_height,
      )
      .setScale(config.pack.render.scale)
      .setDepth(state.position.y);
    const label = this.add
      .text(state.position.x, state.position.y + 10, config.pack.display_name, {
        color: "#f4f3e7",
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        backgroundColor: "#1a2b26cc",
        padding: { x: 5, y: 2 },
      })
      .setOrigin(0.5, 0)
      .setDepth(state.position.y + 1);
    const bubble = this.add
      .text(state.position.x, state.position.y - config.pack.render.frame_height * config.pack.render.scale * 0.74, "", {
        color: "#101914",
        fontFamily: "system-ui, sans-serif",
        fontSize: "16px",
        fontStyle: "bold",
        stroke: "#101914",
        strokeThickness: 0.7,
        backgroundColor: "#fffdf8",
        padding: { x: 12, y: 8 },
        align: "center",
        lineSpacing: 3,
        resolution: 2,
        wordWrap: { width: 240 },
      })
      .setOrigin(0.5, 1)
      .setDepth(60000)
      .setVisible(false);
    this.#displays.set(config.actorId, { sprite, label, bubble, config, lastAnimation: "" });
    this.syncActor(state);
  }

  private registerAnimations(config: ActorViewConfig): void {
    for (const state of ["stand", "walk", "idle"] as const) {
      for (const direction of ["down", "left", "right", "up"] as const) {
        const resolved = resolveAnimation(config.pack, state, direction);
        const key = animationKey(config.actorId, state, direction);
        if (this.anims.exists(key)) continue;
        this.anims.create({
          key,
          frames: resolved.frames.map((frame) => ({ key: textureKey(config.actorId), frame })),
          frameRate: resolved.fps,
          repeat: resolved.loop ? -1 : 0,
        });
      }
    }
  }

  private syncActor(state: StageActorState): void {
    const display = this.#displays.get(state.actor_id);
    if (!display) return;
    const animation = animationKey(state.actor_id, state.locomotion, state.facing);
    if (animation !== display.lastAnimation) {
      display.sprite.play(animation, true);
      display.lastAnimation = animation;
    }
    display.sprite.setPosition(state.position.x, state.position.y).setDepth(state.position.y);
    display.label.setPosition(state.position.x, state.position.y + 10).setDepth(state.position.y + 1);
    display.bubble
      .setPosition(
        state.position.x,
        state.position.y - display.config.pack.render.frame_height * display.config.pack.render.scale * 0.74,
      )
      .setScale(1 / Math.max(this.cameras.main.zoom, 0.01))
      .setText(state.speech ?? "")
      .setVisible(state.speech !== null);
  }

  private readMovementIntent(): { x: number; y: number } {
    const keys = this.#movementKeys;
    if (!keys || isTextEntryElement(document.activeElement)) return { x: 0, y: 0 };
    const x = Number(keys.D?.isDown || keys.RIGHT?.isDown) - Number(keys.A?.isDown || keys.LEFT?.isDown);
    const y = Number(keys.S?.isDown || keys.DOWN?.isDown) - Number(keys.W?.isDown || keys.UP?.isDown);
    return { x, y };
  }

  private focusStageInput(): void {
    const activeElement = document.activeElement;
    if (isTextEntryElement(activeElement)) activeElement.blur();
    this.game.canvas.focus({ preventScroll: true });
  }

  private createMinimap(): void {
    const mapWidth = this.#options.scene.map.width * this.#options.scene.map.tile_size;
    const mapHeight = this.#options.scene.map.height * this.#options.scene.map.tile_size;
    this.cameras.main.setBounds(0, 0, mapWidth, mapHeight);
    const bounds = this.minimapBounds();
    const minimap = this.cameras
      .add(bounds.x, bounds.y, bounds.width, bounds.height)
      .setName("stage-minimap")
      .setBackgroundColor(0x0c1713)
      .setRoundPixels(true)
      .setBounds(0, 0, mapWidth, mapHeight)
      .setZoom(Math.min(bounds.width / mapWidth, bounds.height / mapHeight))
      .centerOn(mapWidth / 2, mapHeight / 2);
    this.#minimap = minimap;

    const viewport = this.add.graphics().setDepth(100000);
    this.cameras.main.ignore(viewport);
    this.#minimapViewport = viewport;

    const frame = this.add.graphics().setScrollFactor(0).setDepth(100001);
    minimap.ignore(frame);
    this.#minimapFrame = frame;
    for (const display of this.#displays.values()) {
      minimap.ignore([display.label, display.bubble]);
    }
    this.drawMinimapFrame();
    this.updateMinimapViewport();
  }

  private updateMinimapViewport(): void {
    const graphics = this.#minimapViewport;
    if (!graphics) return;
    const view = this.cameras.main.worldView;
    graphics.clear().lineStyle(3 / Math.max(this.#minimap?.zoom ?? 1, 0.01), 0xff5d66, 1);
    graphics.strokeRect(view.x, view.y, view.width, view.height);
  }

  private drawMinimapFrame(): void {
    const frame = this.#minimapFrame;
    if (!frame) return;
    const bounds = this.minimapBounds();
    frame
      .clear()
      .lineStyle(1, 0xdce9df, 0.9)
      .strokeRect(bounds.x - 5, bounds.y - 5, bounds.width + 10, bounds.height + 10);
  }

  private minimapBounds(): { x: number; y: number; width: number; height: number } {
    const width = Math.min(222, Math.max(150, this.scale.width * 0.24));
    const height = Math.min(150, Math.max(100, this.scale.height * 0.22));
    return { x: this.scale.width - width - 16, y: 16, width, height };
  }

  private handleResize(): void {
    const minimap = this.#minimap;
    const mapWidth = this.#options.scene.map.width * this.#options.scene.map.tile_size;
    const mapHeight = this.#options.scene.map.height * this.#options.scene.map.tile_size;
    if (minimap) {
      const bounds = this.minimapBounds();
      minimap
        .setPosition(bounds.x, bounds.y)
        .setSize(bounds.width, bounds.height)
        .setZoom(Math.min(bounds.width / mapWidth, bounds.height / mapHeight))
        .centerOn(mapWidth / 2, mapHeight / 2);
      this.drawMinimapFrame();
    }
    this.applyCameraCue();
  }

  private applyCameraCue(): void {
    const camera = this.cameras.main;
    const cue = this.#cameraCue;
    const tileSize = this.#options.scene.map.tile_size;
    const mapWidth = this.#options.scene.map.width * tileSize;
    const mapHeight = this.#options.scene.map.height * tileSize;
    camera.stopFollow();

    if (cue.type === "camera.overview") {
      camera.setZoom(Math.min(this.scale.width / mapWidth, this.scale.height / mapHeight));
      camera.centerOn(mapWidth / 2, mapHeight / 2);
      return;
    }

    camera.setZoom(cue.zoom);
    if (cue.type === "camera.follow_actor" || cue.type === "camera.focus_actor") {
      const actor = this.#displays.get(cue.actor_id);
      if (!actor) return;
      if (cue.type === "camera.follow_actor") {
        camera.startFollow(actor.sprite, true, 0.12, 0.12);
      } else {
        camera.centerOn(actor.sprite.x, actor.sprite.y);
      }
      return;
    }
    if (cue.type === "camera.focus_anchor") {
      const anchor = this.#options.scene.anchors.find((candidate) => candidate.id === cue.anchor_id);
      if (anchor) camera.centerOn((anchor.position.x + 0.5) * tileSize, (anchor.position.y + 0.5) * tileSize);
      return;
    }
    if (cue.type === "camera.focus_zone") {
      const zone = this.#options.scene.zones.find((candidate) => candidate.id === cue.zone_id);
      if (zone) {
        camera.centerOn(
          (zone.bounds.x + zone.bounds.width / 2) * tileSize,
          (zone.bounds.y + zone.bounds.height / 2) * tileSize,
        );
      }
      return;
    }
    camera.centerOn(cue.center.x, cue.center.y);
  }
}

export function createStageGame(options: StageRendererOptions): StageGameController {
  const runtimeScene = new RuntimeScene(options);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    backgroundColor: options.scene.map.background_color,
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: options.parent.clientWidth,
      height: options.parent.clientHeight,
    },
    scene: [runtimeScene],
  });
  return {
    destroy: (removeCanvas = true) => game.destroy(removeCanvas),
    setCameraCue: (cue) => runtimeScene.setCameraCue(cue),
    cameraState: () => runtimeScene.cameraState(),
  };
}

function resolveAnimation(
  pack: CharacterPack,
  requested: ActorLocomotion,
  direction: Direction,
  visited = new Set<ActorLocomotion>(),
): ResolvedAnimation {
  if (visited.has(requested)) throw new Error(`Animation fallback cycle in ${pack.actor_id}: ${requested}`);
  visited.add(requested);
  const animation = pack.animations[requested];
  const frames = animation.directions[direction];
  if (frames?.length) return { state: requested, frames, fps: animation.fps, loop: animation.loop };
  if (!animation.fallback) throw new Error(`Missing animation ${pack.actor_id}/${requested}/${direction}`);
  return resolveAnimation(pack, animation.fallback, direction, visited);
}

function textureKey(actorId: string): string {
  return `actor:${actorId}`;
}

function mapTextureKey(sceneId: string): string {
  return `map:${sceneId}`;
}

function animationKey(actorId: string, state: ActorLocomotion, direction: Direction): string {
  return `actor:${actorId}:${state}:${direction}`;
}

function assetUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function parseColor(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

function pixelBounds(
  bounds: { x: number; y: number; width: number; height: number },
  tileSize: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: bounds.x * tileSize,
    y: bounds.y * tileSize,
    width: bounds.width * tileSize,
    height: bounds.height * tileSize,
  };
}

function isTextEntryElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.matches("input, textarea, select") ||
    element.isContentEditable
  );
}
