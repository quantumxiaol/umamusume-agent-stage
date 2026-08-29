# Agent Stage 接入

Stage 不维护自己的常驻后端。浏览器持有地图、角色坐标、碰撞、寻路和任务状态；[`umamusume-agent`](https://github.com/quantumxiaol/umamusume-agent) 负责角色回复与 Director 决策。

## HTTP 链路

- `GET /characters`：返回 Agent 可用角色名，页面与本地 mapping 取交集；
- `GET /stage/capabilities`：检查 `agent_stage_api.v1` 与动作能力；
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

Agent 不保存 Stage 坐标，也不直接操作 Phaser。前端的 `@uma-stage/agent-client` 负责 HTTP、Zod 响应校验和动作转换，Runtime 仍会做最终控制权与目标校验。

## 会话、场景与角色绑定

一个多人会话可以包含分散在不同 Scene 的角色。每一轮只提交当前可见 Scene 中的 Agent Actor：

- `target_actor_ids` 是本轮当前场景中的目标 Agent actor ID；
- `actor_bindings` 只绑定这些 Agent actor ID 与真实 Stage actor ID；
- `live_stage.actors` 只描述当前 Scene 的训练员与在场角色；
- 留在其他 Scene 的角色仍保留在会话和对话历史中，但不能在本轮发言或接收动作。

这条边界避免为缺席角色伪造坐标，也避免角色隔着地图参与现场对话。若请求显式把一个缺席角色列为本轮目标，Agent 应以缺少有效 Stage 绑定拒绝请求。

## Director 语义

单角色 Stage 会话仍保留 Director：角色模型先按角色设定生成语言动作与对白，Director 再结合训练员输入、角色回复、场景语义和实时状态生成舞台动作。单角色只省略多人发言者选择，不跳过动作导演。

多人会话中，Director 的可发言角色和可动作角色都限制为本轮绑定集合。返回任何未绑定 Actor、未知 Anchor/Slot 或越权动作都会被 Agent 或 Runtime 丢弃。

## 动作选择

- `actor.approach(target_actor_id)`：一次性走近目标；“过来”“到我身边”使用它；
- `actor.follow(target_actor_id)`：持续跟随目标，直到停止或被其他移动命令替换；
- `actor.stop_follow`：只解除跟随；`actor.stop` 也会解除并停止移动；
- `actor.face_actor(target_actor_id)`：不移动，只根据双方实时位置面向目标；
- `actor.move_to(anchor_id)`：前往喷泉、长椅等命名地点，不使用模型生成坐标；
- `dialogue.say`：把角色回复显示为场内气泡。

未指定会面站位时，马娘优先停在训练员画面上方并朝下，以显示正面；首选格不可达时才回退到其他安全位置。跟随者会随训练员跨 Portal，未跟随者留在原 Scene。

Stage 契约还支持 `actor.travel_to_scene(target_scene_id, target_spawn_id?)`。当前前端可以执行它，Director 主动规划连续跨地图旅行仍属于后续 World scheduler 工作。

## 本地配置

Stage 根目录 `.env`：

```text
UMAMUSUME_AGENT_URL=http://127.0.0.1:1111
UMAMUSUME_AGENT_API_ACCESS_KEY=与 Agent 后端 API_ACCESS_KEY 相同
```

修改 Agent Stage 服务后，需要重启未开启 `--reload` 的 uvicorn 进程，并刷新 Stage 页面重新创建会话。

## GitHub Pages 与 key

生产环境由 GitHub Pages 直接请求 HF Space。`UMAMUSUME_AGENT_API_ACCESS_KEY` 注入 Vite 后会进入浏览器 bundle，只能作为降低无目标扫描的软门槛，不能作为真正秘密。后端仍需设置速率限制、token/金额额度和可轮换 key。

完整生产配置见 [`deployment.md`](deployment.md)。
