# Stage 架构

## 定位与原则

Stage 是三层系统中的演出与交互舞台，不承担长期记忆或高级决策。它负责可靠加载角色与地图、执行玩家/剧本/Agent 的统一命令，并把结果作为事件、快照和可等待任务反馈给上层。

浏览器中的 `StageRuntime` 是单机阶段的唯一权威。Phaser 只把 Runtime 快照画出来；Vue 负责组合、角色选择和观察面板；Agent 返回声明式动作，浏览器校验并转换成 `StageCommand` 后才能改变世界。

## 技术栈

| 领域 | 选择 | 职责 |
| --- | --- | --- |
| 契约与核心 | TypeScript strict、Zod 4 | 单一类型来源、运行时校验、JSON Schema、确定性 Runtime |
| Web 外壳 | Vue 3、Pinia、Vite 8 | 内容装配、舞台切换、状态投影 |
| Agent HTTP | fetch、Zod、`@uma-stage/agent-client` | 会话、实时上下文、动作响应与命令转换 |
| 2D 表现 | Phaser 4 | 动画、输入、相机、Canvas/WebGL |
| 地图内容 | ChibiWeaver MapWeaver、SceneWeaver | 地图生成/预览、单向同步、构建时编译与图连通校验 |
| 测试 | Vitest | 核心、协议与内容构建可脱离 UI 测试 |

## 数据与控制流

```text
ChibiWeaver ──► CharacterPack ─┐
MapWeaver ────► ScenePack ─────┼─► StageDefinition ─► apps/web
registries ────────────────────┘                       │
PerformanceScript ─► role/cue compiler ───────────────┤
                                                       ▼
StageRuntime.inspect ─► live_stage ─► Agent /stage/turn
        ▲                                  │
        │                                  ▼
        └── StageCommand ◄── AgentStageAction + dialogue
        │
Script / Player ───────────────────────────┤
                                           ├─► StageTask / StageEvent
                                           └─► snapshot ─► Phaser
```

依赖保持单向：

- `contracts` 不依赖业务包；
- `core` 只依赖 `contracts`，不得 import Phaser、Vue 或 FastAPI；
- `renderer-phaser` 读取 Runtime 快照，不保存第二份世界状态；
- `agent-client` 只负责 Agent HTTP 协议与 `AgentStageAction → StageCommand`；
- `apps/web` 是 composition root；
- `sceneweaver` 只在构建期运行。

## 内容装配

- `CharacterRegistry` 将稳定的 bundle ID 映射到 `actor.json`，并声明 `base20` 或 `fallback` 动画档位；
- `CharacterAgentMapping` 将 `character_id`、Agent 中文名、Stage actor ID、制服/决胜服 bundle 绑定起来；
- `StageRegistry` 列出可进入舞台及默认舞台；
- `StageDefinition` 把一个 ScenePack、Actor 实例、出生点和控制权组合起来；
- `PerformanceScript` 用稳定 `role_id` 描述 cast、场景与 beat；Stage 适配器把 role 绑定为 actor ID，anime 适配器把相同 role 映射为立绘、字幕与音轨；
- `ScenePack` 保存 MapWeaver tileset/layer、navigation、landmark、zone、anchor/slot、spawn、portal 和 activity path；
- `WorldPack` 描述学院场景拓扑；`WorldNavigation` 以实际 Portal 为边规划跨 Scene 最短路线，不把整所学校塞进一张地图。

构建期会交叉验证 mapping、registry、base20、outfit、bundle、atlas 边界、stage、scene、spawn 和 portal 目标，避免把内容错误拖到运行期。

## 运行时模型

### 命令、任务与控制权

当前公开命令为：

- `actor.move_to`：移动到命名 Anchor/Slot 或底层 tile；
- `actor.follow_activity_path`：按语义路径循环 1–10 次；
- `actor.follow`：启用持续的 Actor 目标追踪并保持 1–4 tile 距离；
- `actor.stop_follow`：解除持续跟随；`actor.stop` 也会解除；
- `actor.face`、`actor.stop`；
- `dialogue.say`。

locomotion 与 speech 是独立频道。移动支持 `reject`、`queue`、`replace` 策略。每条命令返回 `StageTask`，最终状态是 `completed`、`failed` 或 `cancelled`；“accepted”不等于“arrived”。`actor.follow` 的任务在跟随模式成功启用时完成，持续状态记录在 Actor 快照中，避免一个永不结束的任务阻塞同一轮 Agent action 队列。

每个 Actor 同一时刻只有一个 `control_owner`：`player`、`agent`、`script` 或 `system`。非 system 命令必须来自当前 owner。网页每轮把实时 inspect 与 Agent/Stage actor binding 发给 `/stage/turn`；Agent 先按绑定、Actor、Anchor 和 Slot 白名单过滤，StageRuntime 再做最终校验。

### 行走、路径与 Portal

Runtime 在 tile 语义层做 A*，在世界像素层连续插值。动态 Actor 占用和 Anchor Slot 预定可避免角色抢同一落点。ActivityPath 在一个 locomotion task 内依次走过全部检查点，因此可整体等待、替换或取消。

Actor 首次进入 Portal tile 时产生一次 `portal.entered`。Web 根据目标 scene/spawn 重新装配舞台；当前跟随绑定会在这次换图中恢复。

动态 cast 不会把第二名以后角色随意丢到地图另一端：Runtime 装配先保留地图显式 spawn 与 Portal 目标，再围绕重复的首选 spawn 生成确定性的临时编队站位；`assignStageSpawns` 按与首选 spawn 的曼哈顿距离分配。临时站位只存在于运行时，不反写 MapWeaver 内容。

场内路线与跨图路线是两层职责：

```text
WorldNavigation: Scene A ─portal─► Scene B ─portal─► Scene C
                                      │
GridNavigation: actor tile ─A*─► 当前 Scene 的 portal/anchor tile
```

`WorldRouteStep` 明确给出 `from_scene_id / portal_id / exit_position / target_scene_id / target_spawn_id`。这使导演未来只声明跨图目的地，执行器仍能逐图使用确定性 A*，而不是让 LLM 生成坐标。

### 镜头不是世界状态

`CameraCue` 是独立的表现契约，不属于 Actor `StageCommand`：

- `camera.follow_actor`：持续跟随训练员或出演角色；
- `camera.focus_actor`：切到角色当前位置但不继续跟随；
- `camera.focus_anchor` / `camera.focus_zone`：固定命名场景区域；
- `camera.fixed`：固定世界像素中心；
- `camera.overview`：整图总览。

Phaser Controller 执行 cue，同时保留跟随相机边界、小地图、Portal 标记和主视野框。当前网页既可手动验证这些模式，也可从 `PerformanceScript` 的 camera cue 执行；Agent Stage Director 尚未返回 CameraCue，后续应在 `/stage/turn` 响应中增加独立 `camera_cues` 字段，而不是伪装成角色动作。

## 两种导演输入，共用同一个舞台

- **实时 Agent 模式**：`umamusume-agent` 根据训练员输入、角色回复与 `live_stage` 返回一个或多个结构化动作；网页把整组 cast 绑定到同一会话并依次等待动作终态。
- **确定性短剧模式**：`PerformanceScript` 的 scene 依次切换，beat 依次执行，同一 beat 的 cues 并行；`wait_for: all` 会等待移动、对白和 wait cue 完成后才进入下一 beat。结束或失败后控制权会归还给 player/agent。

两者都只通过 `StageCommand`、`CameraCue`、`StageTask` 和 `StageEvent` 接触 Runtime。Agent 不操作 Phaser；剧本也不保存第二份坐标状态。

### 当前跨地图边界

当前 `StageRuntime` 仍是单 Scene 实例：玩家走入 Portal 后，网页会重建目标 Scene。跨地图路线已经可以规划，但尚未自动连续执行，也尚未持久保存分散在不同 Scene 的多名 Actor。要支持“导演在不同地图角色之间切镜头”，下一步应增加浏览器端 `WorldRuntime`：持有 `actor_id → scene_id/position`，按当前 CameraCue 只挂载一个 Scene renderer，并在后台推进其他 Scene 的任务。这个扩展不要求新增 Stage 后端，也不改变 Agent 是决策端、浏览器是世界权威的边界。

## Agent HTTP 边界

普通 `/chat`、`/director/*` 与新增 `/stage/*` 是并列能力。Stage 会话使用专用导演提示词，但复用 Agent 的角色加载、导演规划、角色回复与会话隔离。Agent 不反向请求浏览器：

1. 浏览器从 `/characters` 与本地 mapping 计算可出演交集；
2. `/stage/sessions` 返回本次会话真实的 Agent actor ID；
3. 浏览器将它绑定到当前 Stage actor ID；
4. `/stage/turn` 接收 `live_stage` 并返回经过白名单过滤的 `stage_actions`；
5. 浏览器逐条转换并等待 `StageTask` 终态。

GitHub Pages 生产环境直接调用 HF Space。浏览器内 API key 只是轻量门槛，不能当成机密；后端仍需限流、额度控制与 key 轮换。

## 下一阶段

1. 为 `umamusume-anime` 增加 `PerformanceScript → structured script/timeline` 适配器，先复用对白、字幕、音频、场景背景和角色立绘提示；
2. 把网页内的示例执行逻辑抽成独立 ShowRunner，增加暂停、跳过、取消、逐 beat 调试与执行报告；
3. 增加浏览器端 `WorldRuntime`，让多名 Actor 可处于不同 Scene，并连续执行 `WorldRoutePlan`；
4. 为 Agent `/stage/turn` 增加独立 `camera_cues`，并允许把一次实时会话录制为可编辑的 `PerformanceScript`；
5. 增加表情、入场/退场、交互、道具与角色编队命令；只有出现多客户端或持久世界需求后，再评估把 Runtime 权威迁到服务端。
