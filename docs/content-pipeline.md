# 内容制作管线

## 角色

ChibiWeaver 输出目录应包含：

```text
actor.json
atlas.json
atlas.png
```

优先导入 ChibiWeaver `bundle` 命令生成的自包含目录（本例是 `output/.../runtime`），不要把 `demo/actors` 当作发布包。demo manifest 允许引用仓库其他目录，旁边可能残留未被 demo 使用的旧图片。

```bash
pnpm import:actor -- \
  /path/to/chibi_weaver/output/character/runtime/actor.json \
  content/characters/<bundle-id>
```

导入器会遵循 `actor.json` 解析真正的 atlas 文件，校验后复制到目标目录并统一改写为 `atlas.png`/`atlas.json`。Stage 随后按 `stand → walk → idle` 状态机播放。

生产角色在 `content/characters/registry.json` 中标为 `base20`：四方向 stand 各 1 帧、walk 各 2 帧、idle 各 2 帧，总计恰好 20 个唯一帧引用，并且不允许 fallback。这样新增图片或 atlas 重排时，数量不一致会在构建期失败，而不会把 down/left 等帧误播成 idle。Trainer 这类控制器占位包可以显式标为 `fallback`，缺失动画必须在清单中声明回退目标。

`pnpm build:content` 还会读取 PNG 的真实 IHDR 尺寸，确认 atlas meta 尺寸一致、每个引用帧存在且矩形没有越界。只更新 `atlas.json`、却误带旧版小尺寸 PNG 的 Bundle 会直接构建失败。

### 批量同步完整角色 roster

ChibiWeaver 批量输出准备完成后，可一次同步全部严格 base20 包：

```bash
pnpm sync:chibi-roster -- ../chibi_weaver/output
```

同步器会扫描所有 `runtime/actor.json`，执行 base20、atlas 引用和 PNG 边界校验，只导入完整包，并重建 `content/characters/registry.json`。正式 roster 必须满足：每名角色同时拥有 `uniform` 与 `race-outfit`，并包含一个 `trainer_v02`。旧版 stand-only/fallback runtime 会被报告并跳过。

输出目录使用稳定 bundle ID，例如：

```text
content/characters/rice-shower-uniform/
content/characters/rice-shower-race-outfit/
content/characters/trainer/
```

可以先用 `--dry-run` 只做全量校验，不写入文件：

```bash
pnpm sync:chibi-roster -- ../chibi_weaver/output --dry-run
```

## 地图与场景

地图以相邻 `chibi_weaver/map-lab` 的 MapWeaver 输出为唯一编辑源。不要在 Stage 和 ChibiWeaver 两边分别维护地图；在 ChibiWeaver 完成生成和 demo 验收后执行：

```bash
pnpm sync:mapweaver ../chibi_weaver/map-lab
```

同步器会复制共享 tileset，转换 `map_scene.v1 → scene_pack.v1`，同步世界拓扑，并按每张可游玩地图生成训练员 + 当前 Agent 角色的 StageDefinition。每个 Stage 场景目录包含：

```text
scene.map.json      # MapWeaver 原始运行时快照
scene-plan.yaml     # MapWeaver 语义规划快照
scene.json          # Stage ScenePack，由同步器生成，不手改
```

关键字段映射如下：

| MapWeaver | Stage ScenePack | 用途 |
| --- | --- | --- |
| `tileset + layers` | `tileset + layers` | Phaser 原生瓦片分层渲染 |
| `blocked_tiles` | `navigation.blocked_tiles` | 场内 A* 与玩家碰撞 |
| `landmarks` | `landmarks` | 非瓦片补绘与场景标志物 |
| `zones.kind` | `zones.type` | 导演理解与固定镜头区域 |
| `anchors` | `anchors` | 命名交互/移动/镜头目标 |
| `spawns` | `spawns` | Actor 出生点与 Portal 到达点 |
| `portals` | `portals` | 跨 Scene 图的有向边 |
| `activity_paths` | `activity_paths` | 训练、巡逻和演出路径 |

`pnpm build:content` 会确认 tile layer 格子数、tileset 文件、Stage/Scene/Spawn 引用、Portal 目标、WorldPack location/connection，以及角色内容的全部约束。任何地图更新都应先在 ChibiWeaver demo 测试，再同步并执行 `pnpm check`。

## 舞台装配

地图和角色通过数据文件组合，不在 Vue 页面中写死：

```text
content/characters/registry.json
content/characters/agent-mapping.json
content/stages/registry.json
content/stages/*.stage.json
```

`StageDefinition` 引用一个 ScenePack，并给每个角色实例指定 bundle、spawn、control owner 和是否由玩家控制。构建还会确认 Stage 引用的 bundle/spawn 存在，以及每个 Portal 的目标 Scene 和目标 Spawn 都能解析。

`agent-mapping.json` 为每名可出演角色声明稳定 `character_id`、Agent 中文角色名、Stage actor ID，以及制服/决胜服 bundle。`pnpm build:content` 会确认两套 bundle 都已注册为严格 base20 character，并分别使用 `uniform` / `race_outfit` outfit_id。Agent 角色可以多于 Stage roster；页面只展示两边当前都有的角色。

## 旧 Tiled 编译器

`packages/sceneweaver` 仍保留 `map.tmj + scene.meta.json → ScenePack` 编译器，供实验或迁移旧地图使用；特雷森正式地图不再走这条双源管线，以 MapWeaver 同步结果为准。
