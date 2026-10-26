# PerformanceScript 与短剧管线

## 为什么需要中间剧本层

`umamusume-agent-stage` 和 `umamusume-anime` 的输出形式不同：Stage 需要等待真实寻路和角色任务，anime 需要提前得到毫秒时间线、音频和画面素材。两边不应该直接依赖 Phaser 或 Remotion。当前支持两种等价入口：Stage 原生 `PerformanceScript`，以及保留 anime `lines`、只增加一个 `stage` 字段的兼容超集。

```text
Markdown / Agent / 人工编辑
              │
              ▼
 anime JSON + stage 字段 ───────► umamusume-anime
 lines / audio / subtitle          TTS / Remotion
              │
              ▼ compile
     PerformanceScript v1
       cast / scenes / beats
      actor / dialogue / camera
              │
              ▼
       Phaser live playback
```

权威 Schema 是 [`packages/contracts/src/performance-script.ts`](../packages/contracts/src/performance-script.ts) 和 [`packages/contracts/src/anime-stage-script.ts`](../packages/contracts/src/anime-stage-script.ts)，生成的 Draft 2020-12 JSON Schema 分别是 [`schemas/performance-script.v1.json`](../schemas/performance-script.v1.json) 与 [`schemas/anime-stage-script.v1.json`](../schemas/anime-stage-script.v1.json)。兼容示例在 [`content/performances/admire-vega-starlight.anime.json`](../content/performances/admire-vega-starlight.anime.json)。

## anime JSON 兼容超集

anime 原有字段保持原样：

```json
{
  "projectId": "AdmireVega_Stage_Demo",
  "title": "深夜跑道上的织女星",
  "lines": [
    {
      "id": "av014",
      "type": "dialogue",
      "speakerId": "admire_vega",
      "background": "track_night",
      "audio": "draft/admire_vega_audio/av014.wav",
      "spokenText": "眠れなかっただけ。",
      "subtitleJa": "眠れなかっただけ。",
      "subtitleZh": "只是睡不着而已。"
    }
  ],
  "stage": {
    "schema_version": "anime_stage.v1",
    "performance_id": "admire_vega_starlight",
    "cast": [],
    "scenes": [],
    "directions": {}
  }
}
```

只有 `stage` 是新增字段：

- `cast` 把 anime `speakerId` 映射为 Stage `role_id/character_id/outfit_id`；
- `scenes[].backgrounds` 复用每行已有的 `background`，映射到 `stage_id`，并可声明出生点、初始朝向和轻量时间天气；
- `directions` 以原始 `line.id` 为键。`before` 在对白前等待完成，`during` 与对白并行，`after` 在对白完成后执行；
- `audio` 会从 Stage 内容根加载并在浏览器中预解码；有音频时，其真实时长控制气泡、字幕推进和下一句开始，`duration_ms` 仅作为无音频行的回退时长；
- `line_gap_ms` 是一行音频完整结束后的额外停顿，不会截断正在播放的台词；
- 原 anime 的 `director.py`、TTS 与 Remotion 只读取已知字段，会忽略额外的 `stage`，因此同一个 JSON 可在两个项目中使用。

Stage 构建时会把兼容 JSON 编译为 `PerformanceScript`，然后继续使用同一个任务、寻路、镜头和控制权执行器；Runtime 不需要认识 anime 字段。

## 执行语义

- `cast` 用稳定 `role_id` 关联 `character_id` 和 `outfit_id`。剧本 cue 只引用 role，不写 `uma_*` actor ID，也不直接引用 CharacterBundle；
- `scenes` 按数组顺序执行。每个 scene 指向一个已注册 `stage_id`，场景切换时用 `placements.spawn_id` 重建 Runtime，执行可选的 `placements.facing`，并应用可选的 `environment`；
- `beats` 按数组顺序执行；同一 beat 内所有 cue 同时启动，所以可以让两名角色并行行走，或让对白与移动同时发生；
- `wait_for: all` 等待该 beat 的移动、对白与 wait cue 全部到达终态；`none` 允许下一个 beat 与当前任务重叠，但离开 scene 前仍会收拢后台任务；
- `hold_ms` 是 beat 完成后的额外停顿；
- `actor.move_to` 只使用 Anchor 或另一个 role，不把模型生成的裸坐标写入剧本；移动到 role 时，`distance_tiles` 是期望的会面间距（受地形限制时退到更近的可达格），并可用 `preferred_side: above|below|left|right|nearest` 声明镜头站位，默认 `above`；
- camera cue 与角色命令分离。镜头不会修改世界状态；
- camera cue 的 `transition_ms` 默认是 `450`，会平滑平移并变焦；需要剪辑式硬切时显式写 `0`。连续对白应优先保持稳定双人镜头，只在叙事重点切近景；
- `spoken_text`、双语字幕、`audio_path` 与 `render_hints` 不影响 Stage 世界权威；其中 `audio_path` 还供网页演出器播放现成 TTS。

当前 cue 包括：

- `actor.move_to`、`actor.follow_activity_path`、`actor.follow`、`actor.stop_follow`、`actor.face`、`actor.face_actor`、`actor.stop`；
- `dialogue.say`、`narration.say`、`stage.wait`；
- `camera.follow_actor`、`camera.focus_actor`、`camera.focus_anchor`、`camera.focus_zone`、`camera.fixed`、`camera.overview`。

构建时不仅校验 JSON 形状，还会检查 cast 角色映射、服装、stage、spawn、anchor、zone 和 activity path。role、scene、beat、cue ID 必须唯一，所有 role 引用必须存在。

## 与 umamusume-anime 的字段关系

当前兼容编译器按下列规则把 anime 字段和新增的 `stage` 扩展转换成 PerformanceScript：

| PerformanceScript | umamusume-anime |
| --- | --- |
| `performance_id` | `stage.performance_id`（原 `projectId` 保持不变） |
| cast `role_id/character_id/outfit_id` | `stage.cast[]` 与原 `speakerId` 的映射 |
| scene `stage_id/placements/environment` | `stage.scenes[]` |
| line 所属 scene | `lines[].background` → `stage.scenes[].backgrounds` |
| 行前、行中、行后 cue | `stage.directions[line.id].before/during/after` |
| `dialogue.say.spoken_text` | `spokenText` |
| `subtitle_ja/subtitle_zh` | `subtitleJa/subtitleZh` |
| `audio_path` | `audio` |
| `narration.say` | `type: narration` line |

行走和镜头保存在额外的 `stage.directions` 中，anime 当前可以忽略它们；后续若 Remotion 需要二维走位或剪辑提示，可以读取同一字段，而不必改变对白、TTS、audio QC、`director.py` 或现有 timeline。

## 与实时 Agent 的关系

Agent 模式继续直接返回 `AgentStageAction`，因为实时会话不需要先生成完整短剧。未来增加 Recorder 后，可以把一轮或多轮的对白、成功完成的 StageCommand、CameraCue 和场景切换记录成 beats，保存为 PerformanceScript，再交给人工编辑或 anime 渲染。录制时应只记录 `completed` 的确定性结果，失败动作写入执行报告而不是主剧本。

## 当前边界

- 独立 `ShowRunner` 支持多 scene、并行 cue、任务等待、暂停、取消与失败清理。网页显示当前 beat，并提供暂停/继续/结束按钮；尚无跳到指定 beat、倒带或检查点恢复；
- scene 切换会按 placements 重新生成 cast，不保存留在旧地图的后台角色；这一点应由后续 `WorldRuntime` 解决；
- 浏览器会在用户点击“播放星光短剧”后解锁音频，并在演出开始前预载剧本引用的音频；缺失或无法解码的音频会明确终止该次演出；
- `render_hints` 是可选适配提示，不是核心语义。Stage 或 anime 缺少某项提示时，应通过各自的 asset/location manifest 补全，而不是把仓库绝对路径写进剧本。

## 播放控制与失败语义

- `wait_for: all` 等待该 beat 的角色任务、音频和镜头的有限平移/变焦完成。持续镜头跟随只等待启用及变焦，不等待被跟随者停止移动；
- 同一 beat 只允许一条镜头 cue；`wait_for: none` 的后台 cue 也会立即捕获失败，取消同场其他未完成 cue，不继续推进剧情；
- 暂停冻结 Phaser 场景、AudioContext 和 ShowRunner 等待计时。页面隐藏后自动暂停，返回后点击“继续”；
- 结束演出会取消待执行和运行中的任务、停止音频与镜头过渡、解除剧本控制。当前场景位置保留，不回滚到演出前；加载中取消会失效化旧加载，再恢复一个可操作场景；
- 音频不存在/不能解码时，在接管舞台前终止准备，不悄悄忽略音频；取消期间晚到的音频解码不会重新开始播放；
- 运行前检查所有场景引用的 Spawn、Anchor、Slot、ActivityPath、Camera Zone；错误包含 scene/beat/cue 标识；
- Slot 指定是精确站位，不存在或不可达就失败。未指定 Slot 的 Anchor 仍允许自动选取候选位置，Actor 相对目标仍允许安全侧回退。
