# 当前能力与阶段边界

这份文档记录仓库当前实现快照和后续开发边界。面向使用者的介绍与启动方式保留在根目录 [`README.md`](../README.md)，实现原则见 [`architecture.md`](architecture.md)。

## 内容覆盖

### 角色

- `CharacterRegistry` 动态加载 ChibiWeaver 角色包；
- 当前同步 29 名角色的制服/决胜服与 1 个训练员，共 59 个严格 base20 CharacterBundle；
- base20 要求 stand 4 帧、walk 8 帧、idle 8 帧，共 20 个唯一帧引用；
- `CharacterAgentMapping` 显式关联稳定角色 ID、Agent 中文名、Stage actor ID 和两套服装；
- playground 可组成 1–4 名角色的 cast；Agent 模式服从后端 `director_max_participants`（当前默认 3 人），每名角色独立选择服装和观察镜头。

### 地图与世界

- 当前同步 19 张可游玩地图及共享 tileset；
- ScenePack 支持瓦片层、碰撞、A*、Anchor/Slot、ActivityPath、Spawn 和 Portal；
- `WorldNavigation` 按 Portal 图规划跨地图路线；
- `WorldPresence` 保存每名 Actor 所在 Scene、最后位置与跟随关系；
- 玩家跨图时只有跟随队伍一起到达，留守角色保留在原地图，回去后从保存位置恢复；
- 同一入口的随行角色会排列在玩家附近的安全格，不长期占用 Portal tile。

地图覆盖与美术打磨顺序见 [`map-coverage.md`](map-coverage.md)，地图同步方式见 [`content-pipeline.md`](content-pipeline.md)。

## 实时舞台

- `StageRuntime` 是角色位置、碰撞、控制权、命令和任务结果的唯一权威；
- Web 采用明亮学院风响应式布局，角色、舞台、对话和控制组件分离，Actor 坐标、原始命令与事件收进折叠诊断区；
- 玩家可用 WASD/方向键移动；
- Runtime/剧本支持移动、训练路线、跟随、停止、朝向和对白；Agent 支持接近等动作，但目前 Agent API 尚未开放训练路线指令；
- 场内移动具有下一格占用、脚底安全距离、动态绕行和有限失败处理；固定 Actor ID 顺序裁决抢道，无法绕开的堵塞会失败，而不是无限原地踏步；
- `StageRuntime.dispose()` 统一取消活动/排队移动与对白并解除跟随；Phaser Controller 的 `ready` 在素材真正加载完成后才兑现，失败会进入页面错误层；
- 明确指定 Anchor Slot 时严格到该槽位，不再自动退回 Anchor 中心；未知 Slot 返回 `INVALID_SLOT`，占用/不可达返回 `NO_REACHABLE_TARGET`；
- 镜头支持跟随 Actor、聚焦 Actor/Anchor/Zone、固定世界坐标和整图预览；
- `M` 切换小地图，`O` 切换当前地图全图，`G` 打开世界连接与出口路线；整图预览退出后恢复先前镜头；
- 环境支持 day/evening/night 与 clear/rain/snow，不复制碰撞地图。

## Agent 与短剧

- `playground` 模式不连接后端，保留基础游戏操作、JSON 短剧和现成音频；Pages 工作流固定使用这一模式；
- `agent` 模式下浏览器直接连接本地或 HF Space 的 `umamusume-agent /stage/*`；本地开发默认保持联调模式；
- Agent 返回结构化 `AgentStageAction`，前端校验并转换为 `StageCommand`；
- `useAgentStage` 管理能力协商、会话、90 秒超时、取消与显式重连重发；换图会取消旧请求和任务，迟到响应不会控制新场景；
- 会话失效不会静默重试；动作部分失败时保留已收到的角色回复，并显示未完成状态；
- 单角色仍经过 Stage Director；多人由 Director 选择发言者和动作；
- 会话可包含分散在多张地图的角色；真实缺席角色可通过 travel/approach/follow 召回，本地动作与场内气泡必须到场后执行；
- `world-travel` 按 WorldNavigation 逐图步行并核对 Portal，支持 NPC 先行与留守召回；离开当前 Scene 后由后台 Runtime 推进，训练员不被锁住，旅行者退场会清理碰撞与显示，可见切换保留最后一帧；旧后端继续使用同图动作；
- `PerformanceScript v1` 描述 cast、scene、并行 beat、动作、对白、音频提示和镜头；
- anime 兼容入口保留 `projectId/title/lines`，只增加根级 `stage` 字段；
- 网页演出器会播放 `audio/audio_path` 指向的现成 TTS，并按实际音频长度同步气泡、字幕和行间停顿；
- 独立 `ShowRunner` 负责串行段落、并行 cue、暂停、取消、错误定位与清理；镜头 cue 等待实际平移/变焦结束；
- 播放前检查地图内容引用和音频，后台标签页自动暂停；取消或失败后释放音频、移动和控制权。

## 项目结构

```text
apps/web/                 Vue 3 外壳、舞台选择与观察面板
packages/agent-client/    umamusume-agent /stage HTTP 客户端与动作转换
packages/contracts/       Character/Scene/Stage/Command/CameraCue 契约
packages/core/            StageRuntime、剧本编译、A* 与世界 Presence
packages/renderer-phaser/ Phaser 瓦片渲染、动画、相机、小地图与天气
packages/sceneweaver/     ScenePack 编译和内容交叉校验
content/                  角色、场景、舞台、世界与短剧内容包
schemas/                  从 Zod 生成的 JSON Schema
docs/                     架构、协议、部署与内容管线
```

## 当前边界

- 当前浏览器会话是世界权威，刷新页面后从默认舞台重新开始；
- 除当前旅行者的路线外，后台 Scene 只保存位置，不持续推进其他时间和行动；
- Agent 跨图旅行由可见 Runtime 与后台 Runtime 协同执行；不支持并发推进多个后台旅行或完整 NPC 日程；
- Agent Stage Director 暂未返回独立 CameraCue；
- JSON 短剧已支持浏览器音频回放；实时 TTS 调度和视频导出仍需继续接入；
- 地图数量已经覆盖主要地点，下一阶段优先处理 Anchor Slot、Portal 落点、遮挡层和美术一致性。
- 本轮没有添加地图内 E 键交互、检查点存档、剧情选项或 World scheduler；开发顺序与手工验收见 [`stage-foundation.md`](stage-foundation.md)。

## 完整校验

```bash
pnpm check
```

校验覆盖内容构建、生成 Schema、TypeScript、Vitest 和 Vite 生产构建。依赖版本固定在 `pnpm-lock.yaml`。
