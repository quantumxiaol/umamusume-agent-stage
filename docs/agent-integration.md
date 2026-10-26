# Agent Stage 接入

Stage 不维护自己的常驻后端。浏览器持有地图、角色坐标、碰撞、寻路和任务状态；[`umamusume-agent`](https://github.com/quantumxiaol/umamusume-agent) 负责角色回复与 Director 决策。

## HTTP 链路

- `GET /characters`：返回 Agent 可用角色名，页面与本地 mapping 取交集；
- `GET /stage/capabilities`：校验 `agent_stage_api.v1`、`agent_stage_turn.v1`、`action_types` 和 `max_stage_actions_per_turn`；
- `GET /capabilities`：读取 `director_max_participants`，Agent 模式据此限制出演人数，playground 仍允许 4 人；
- `POST /stage/sessions`：为所选 cast 创建独立 Stage 会话；
- `POST /stage/turn`：接收训练员输入、当前 `live_stage` 和角色绑定，返回事件与结构化动作。

```text
训练员输入
    │
    ▼
当前 Scene 的 live_stage + actor_bindings
    │
    ▼
umamusume-agent Stage Director
    │
    ├─ character_reply
    └─ stage_actions
            │
            ▼
AgentStageAction → StageCommand → StageRuntime
```

Agent 不保存 Stage 坐标，也不直接操作 Phaser。前端的 `@uma-stage/agent-client` 负责 HTTP、Zod 响应校验和动作转换，Runtime 仍会做最终控制权与目标校验。请求默认 90 秒超时，也可被用户或场景生命周期取消；FastAPI 结构化校验错误和 429 的 `Retry-After` 会转换为可读提示。

## 会话、场景与角色绑定

一个多人会话可以包含分散在不同 Scene 的角色。支持跨图的后端会收到本地及缺席出演角色的绑定：

- `live_stage.actors` 只描述当前 Scene 的训练员与在场角色，不伪造缺席者坐标；
- `remote_actors` 记录缺席 Actor 的真实 `actor_id/scene_id`；缺席绑定也必须带匹配的 `scene_id`；
- `travel_destinations` 提供可选场景及其 Spawn，Director 不能凭空生成目的地；
- `target_actor_ids` 和 `actor_bindings` 可包含这些真实缺席角色，使其能够被召回。

缺席角色只能 travel，或通过指向当前 Scene 目标的 approach/follow 召回，不能直接执行当前地图的 move_to/face 等本地动作。回复可以进入对话记录，场内气泡和后续本地动作必须等角色到达后执行。未声明 travel 能力的旧后端保持 present-only 同图会话，并在缺席召回时提示升级。

`useAgentStage` 统一管理会话和一轮动作：取消或换图会中止 fetch 与旧 Runtime 任务，迟到响应会被丢弃；会话 404 不会自动重复计费请求，而是由用户明确选择“重连并重发”。动作部分失败时已收到的角色回复仍保留在对话中。

NPC 离开当前 Scene 后由后台 Runtime 继续逐图旅行，不锁定训练员输入；后台只同步旅行者 Presence。离开旧 Scene 时角色执行 `despawnActor`，清理占用与显示，召回进入玩家 Scene 时才可见装配，并保留切换前最后一帧。

## Director 语义

单角色 Stage 会话仍保留 Director：角色模型先按角色设定生成语言动作与对白，Director 再结合训练员输入、角色回复、场景语义和实时状态生成舞台动作。单角色只省略多人发言者选择，不跳过动作导演。

多人会话中，Director 的可发言角色和可动作角色都限制为本轮绑定集合。返回任何未绑定 Actor、未知 Anchor/Slot、非法目的地或越权动作都会被 Agent 或 Runtime 丢弃。

## 动作选择

- `actor.approach(target_actor_id)`：一次性走近目标；同图“过来”“到我身边”使用它；缺席时先跨图召回再 approach；
- `actor.follow(target_actor_id)`：持续跟随目标，直到停止或被其他移动命令替换；缺席时先召回，到场后才建立跟随；
- `actor.travel_to_scene(target_scene_id, target_spawn_id?)`：声明跨图目的地，Web 沿真实 Portal 逐图步行，不直接瞬移；`target_spawn_id` 是入口偏好，入口被占时允许邻近安全站位；
- `actor.stop_follow`：只解除跟随；`actor.stop` 也会解除并停止移动；
- `actor.face_actor(target_actor_id)`：不移动，只根据双方实时位置面向目标；
- `actor.move_to(anchor_id)`：前往当前 Scene 的喷泉、长椅等命名地点，不使用模型生成坐标；
- `dialogue.say`：把角色回复显示为场内气泡；角色缺席时只保留对话记录。

未指定会面站位时，马娘优先停在训练员画面上方并朝下，以显示正面；首选格不可达时才回退到其他安全位置。跟随者会随训练员跨 Portal，未跟随者留在原 Scene；留守角色之后可被召回。

## 本地配置

Stage 根目录 `.env`：

```text
UMAMUSUME_AGENT_URL=http://127.0.0.1:1111
UMAMUSUME_AGENT_API_ACCESS_KEY=与 Agent 后端 API_ACCESS_KEY 相同
```

修改 Agent Stage 服务后，需要重启未开启 `--reload` 的 uvicorn 进程，并刷新 Stage 页面重新创建会话。

## GitHub Pages 与 key

Pages 工作流固定使用 playground，不请求 HF Space，也不注入 Agent 地址或 key。若以后显式恢复 agent 构建，`UMAMUSUME_AGENT_API_ACCESS_KEY` 注入 Vite 后会进入浏览器 bundle，只能作为降低无目标扫描的软门槛，不能作为真正秘密；后端仍需速率限制、token/金额额度和可轮换 key。

完整生产配置见 [`deployment.md`](deployment.md)。
