# umamusume-agent-stage

特雷森学院的浏览器端 2D 演出与交互舞台。浏览器里的 `StageRuntime` 是角色位置、动作、控制权与命令结果的唯一权威；Phaser 只负责表现，上层 Agent 通过稳定的 HTTP/JSON 接口行动。

## 当前可用能力

- 用 `CharacterRegistry` 动态加载 ChibiWeaver 角色包；所有出演角色使用严格 base20：stand 4 帧、walk 8 帧、idle 8 帧，共 20 个唯一帧引用；
- 已同步 29 名角色的制服/决胜服与 1 个训练员，共 59 个严格 base20 CharacterBundle；
- `CharacterAgentMapping` 将稳定角色身份、Agent 中文角色名、Stage actor ID 与两套服装 bundle 显式关联，构建时检查完整性；
- 已从 ChibiWeaver MapWeaver 单向同步 9 张可游玩地图与共享 tileset，支持瓦片分层、碰撞、A*、Anchor/Slot、ActivityPath 和闭合 Portal 网络；
- 大地图使用边界约束的 0.8 倍跟随相机与小地图；镜头可跟随训练员/角色、固定在 Anchor/Zone 或切到场景总览；
- `WorldNavigation` 可根据实际 Portal 图规划跨地图最短路线，并返回每一步出口坐标与目标 spawn；
- 用 `StageRegistry + StageDefinition` 决定场景、角色实例、控制权和出生点，不在 Vue 中硬编码内容；
- 玩家可用 WASD / 方向键行走，Agent 可前往 Anchor、接近或持续跟随实时 Actor、停止跟随、转向、沿活动路径行动、说话和停止；
- 浏览器可直接连接本地或 HF Space 上的 `umamusume-agent /stage/*`，把返回的 tool-call 数据转换成 `StageCommand`；

## 启动

主网页需要 Node.js 24 与 pnpm 11。依赖版本已固定在 `pnpm-lock.yaml`。

```bash
pnpm install
cp .env.example .env
```

本地联调时，把 `.env` 指向正在运行的 `umamusume-agent`：

```text
UMAMUSUME_AGENT_URL=http://127.0.0.1:1111
UMAMUSUME_AGENT_API_ACCESS_KEY=与 Agent 后端 API_ACCESS_KEY 相同
```

修改过 Agent 的 `/stage` 服务代码后先重启 Agent，再启动本项目：

```bash
pnpm dev
```

打开 `http://127.0.0.1:4173/`。网页会读取仓库根目录的 `.env`，自动连接 Agent，并为当前选择的角色创建单角色 Stage 会话；切换角色时会自动创建对应的新会话。Agent 不可用时，角色切换、制服/决胜服、地图移动、寻路、ActivityPath 和 Portal 仍可单独测试。

完整校验：

```bash
pnpm check
```

`pnpm check` 覆盖 TypeScript、内容、JSON Schema、单测和生产构建。

重新同步相邻 ChibiWeaver 的完整 roster：

```bash
pnpm sync:chibi-roster -- ../chibi_weaver/output
```

重新同步相邻 ChibiWeaver MapWeaver 的地图、世界拓扑和 Stage 定义：

```bash
pnpm sync:mapweaver -- ../chibi_weaver/map-lab
```

地图以 `chibi_weaver/map-lab` 为编辑源，本仓库中的 `scene.map.json`、`scene-plan.yaml`、tileset 和编译后 `scene.json` 是可部署快照，不应在两边分别修改。

## Agent 接入

主链路由 Agent 仓库提供：

- `GET /characters`：返回 Agent 当前可用中文角色名，页面与本仓库映射取交集；
- `GET /stage/capabilities`：检查 `agent_stage_api.v1`；
- `POST /stage/sessions`：创建独立的 Stage 导演会话；
- `POST /stage/turn`：上传浏览器实时 `live_stage`、角色绑定和训练员事件，接收对白与结构化动作。

前端的 `@uma-stage/agent-client` 负责 HTTP 与响应校验；浏览器将 `AgentStageAction` 转成严格 `StageCommand`，按顺序等待完成。Agent 不保存角色坐标，也不直接操作 Phaser。

单角色 Stage 会话仍保留 Director：角色模型先按原有角色设定生成语言动作与对白，Director 再结合训练员输入、角色回复、场景语义和实时 `live_stage` 生成结构化舞台动作。单角色时只省略“选择哪位角色发言”这一步，不跳过动作导演。多人会话则继续由 Director 同时负责发言调度和舞台动作规划。

相对角色移动使用 `actor.approach(target_actor_id)`；例如“爱织到我这来”只会走近训练员一次。需要在训练员继续移动后仍追踪时使用 `actor.follow(target_actor_id)`，直到 `actor.stop_follow`、`actor.stop` 或其他移动命令替换它。去喷泉、长椅等固定地点才使用 `actor.move_to(anchor_id)`，Agent 不生成或猜测地图坐标。

GitHub Pages 没有保密执行环境。`UMAMUSUME_AGENT_API_ACCESS_KEY` 即使通过 GitHub Secret 注入，最终仍会进入浏览器 bundle；它只能作为降低随手扫描/滥用的轻量门槛，真正的保护仍需依赖后端限流、额度和可轮换 key。

## Workspace

```text
apps/web/                 Vue 3 外壳、舞台选择与观察面板
packages/agent-client/    umamusume-agent /stage HTTP 客户端与动作转换
packages/contracts/       Character/Scene/Stage/Command/CameraCue 的唯一契约
packages/core/            权威 StageRuntime、场内 A* 与跨 Scene 路线规划
packages/renderer-phaser/ Phaser 4 瓦片渲染、相机、小地图与输入适配器
packages/sceneweaver/     ScenePack 编译与内容交叉校验
content/                  角色、场景、舞台和世界内容包
schemas/                  从 Zod 生成的 JSON Schema
docs/                     架构、内容管线与迁移说明
```

设计边界见 [`docs/architecture.md`](docs/architecture.md)，角色与地图制作见 [`docs/content-pipeline.md`](docs/content-pipeline.md)。

## 版权声明

本项目是非官方、非商业的粉丝工具项目，与 Cygames, Inc. 无关联，也未获得其认可或赞助。《ウマ娘 プリティーダービー》及相关角色、名称和设计的权利归其各自权利人所有。

角色像素素材与特雷森场景扩展由项目作者制作；共享基础 tileset 中使用的 Kenney Roguelike/RPG Pack 为 CC0-1.0，完整来源记录见 [`content/tilesets/tracen-campus/license-manifest.json`](content/tilesets/tracen-campus/license-manifest.json)。
