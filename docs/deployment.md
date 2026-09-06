# GitHub Pages 与 HF Space 部署

## 当前默认：Pages 纯前端试玩

GitHub Pages 工作流固定使用 `VITE_STAGE_MODE=playground`。这一版不依赖 HF Space，也不需要设置 Agent Secret：不连接后端、不获取后端角色列表、不创建会话、不发送 `/stage/turn`。右侧显示基础操作和玩法说明，没有聊天输入框或连接重试按钮。

行走、碰撞寻路、跟随／停止跟随、换图与留守、世界连接总览、镜头、昼夜天气，以及预置 JSON 短剧和已合成音频均保留。素材仍需要从静态站点下载；“纯前端”不表示已经支持离线缓存。

发布步骤：

1. 在仓库 Settings → Pages 中选择 GitHub Actions 作为 Source。
2. 推送 `main`，或手动运行 Deploy Stage to GitHub Pages。
3. 工作流用 `pnpm install --frozen-lockfile`、`pnpm check` 构建并发布 `apps/web/dist`。

不需要本轮改动或重启 HF 后端。已有 GitHub Secret 可保留，当前工作流不会读取或注入它。

## 本地联调与模式切换

本地开发：

```text
http://127.0.0.1:4173 (Stage Vite)
        └── HTTP ──► http://127.0.0.1:1111 (umamusume-agent)
```

当前 Pages：

```text
GitHub Pages /umamusume-agent-stage/
        └── 静态素材 + 浏览器 StageRuntime（不连接 Agent）
```

Stage 不需要自己的常驻后端或数据库。Agent 的 `/stage/*` 只返回会话事件与动作；位置、碰撞、寻路、动画和任务状态仍归浏览器 `StageRuntime`。

| 构建开关 | 行为 |
| --- | --- |
| `VITE_STAGE_MODE=playground` | 纯前端试玩，忽略 Agent URL 和 key |
| `VITE_STAGE_MODE=agent` | 允许连接 `.env` 配置的本地／HF Agent |
| 未指定 | 开发服务器默认 `agent`，生产构建默认 `playground` |

本地现有 `.env` 中的 URL/key 无需修改。临时切换试玩：

```bash
VITE_STAGE_MODE=playground pnpm dev
```

预览生产路径：

```bash
VITE_STAGE_MODE=playground pnpm build
pnpm --filter @uma-stage/web exec vite preview
```

打开 `http://127.0.0.1:4174/umamusume-agent-stage/`。开关是构建时配置，修改后需重启开发服务器／重新构建；没有访客可点击的联网开关。

## 以后恢复 Pages 的 Agent 对话

1. 先将 Agent 的新增 `/stage` 服务部署到 HF Space，并确认 `GET /stage/capabilities` 返回 `agent_stage_api.v1`。
2. 在 Stage GitHub 仓库的 Settings → Secrets and variables → Actions 新建 `UMAMUSUME_AGENT_API_ACCESS_KEY`。
3. 修改工作流构建步骤的 `env`：设置 `VITE_STAGE_MODE: agent`，并恢复注入 `UMAMUSUME_AGENT_URL` 和 `UMAMUSUME_AGENT_API_ACCESS_KEY`（后者引用 Secret）。
4. 确认 HF 允许 Pages 站点的跨域请求，再重新构建发布。

Vite 生产 base 已设置为 `/umamusume-agent-stage/`，内容 URL 通过 `import.meta.env.BASE_URL` 生成。

## Key 的实际安全性

试玩构建通过配置白名单仅注入模式及空的 Agent URL/key；Vite 不再按环境变量前缀批量暴露 `.env`。下面的风险说明仅适用于显式启用的 `agent` 构建。

GitHub Secret 只避免 key 直接出现在仓库和 Actions 日志中。它注入 Vite 后会进入浏览器 JavaScript，访问页面的人仍能读取；因此它只能减少无目标扫描，不能承担真正鉴权。建议在 HF 端同时使用：

- IP/会话速率限制；
- 单日 token 或金额额度；
- 可随时轮换的独立 Stage key；
- 对 `/stage/turn` 单独设置更严格限流。
