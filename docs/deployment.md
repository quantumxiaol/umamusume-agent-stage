# GitHub Pages 与 HF Space 部署

## 本地到生产的边界

本地开发：

```text
http://127.0.0.1:4173 (Stage Vite)
        └── HTTP ──► http://127.0.0.1:1111 (umamusume-agent)
```

生产：

```text
GitHub Pages /umamusume-agent-stage/
        └── HTTPS ──► https://quantumxiaol-umamusume-agent.hf.space
```

Stage 不需要自己的常驻后端或数据库。Agent 的 `/stage/*` 只返回会话事件与动作；位置、碰撞、寻路、动画和任务状态仍归浏览器 `StageRuntime`。

## 发布准备

1. 先将 Agent 的新增 `/stage` 服务部署到 HF Space，并确认 `GET /stage/capabilities` 返回 `agent_stage_api.v1`。
2. 在 Stage GitHub 仓库的 Settings → Secrets and variables → Actions 新建 `UMAMUSUME_AGENT_API_ACCESS_KEY`。
3. 在 Settings → Pages 中选择 GitHub Actions 作为 Source。
4. 推送 `main`，工作流会用 `pnpm install --frozen-lockfile`、`pnpm check` 构建并发布 `apps/web/dist`。

Vite 生产 base 已设置为 `/umamusume-agent-stage/`，内容 URL 通过 `import.meta.env.BASE_URL` 生成。

## Key 的实际安全性

GitHub Secret 只避免 key 直接出现在仓库和 Actions 日志中。它注入 Vite 后会进入浏览器 JavaScript，访问页面的人仍能读取；因此它只能减少无目标扫描，不能承担真正鉴权。建议在 HF 端同时使用：

- IP/会话速率限制；
- 单日 token 或金额额度；
- 可随时轮换的独立 Stage key；
- 对 `/stage/turn` 单独设置更严格限流。
