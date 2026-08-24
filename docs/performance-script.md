# PerformanceScript 与短剧管线

## 为什么需要中间剧本层

`umamusume-agent-stage` 和 `umamusume-anime` 的输出形式不同：Stage 需要等待真实寻路和角色任务，anime 需要提前得到毫秒时间线、音频和画面素材。两边不应该直接依赖 Phaser 或 Remotion，而应共享一个语义剧本，再由各自的适配器编译。

```text
Markdown / Agent / 人工编辑
              │
              ▼
     PerformanceScript v1
       cast / scenes / beats
      actor / dialogue / camera
          │              │
          ▼              ▼
     Stage adapter    Anime adapter
   role → actor_id   role → speakerId
   cue → Command     scene → background
   cue → CameraCue   dialogue → line/audio/subtitle
          │              │
          ▼              ▼
  Phaser live playback  Remotion timeline
```

权威 Schema 是 [`packages/contracts/src/performance-script.ts`](../packages/contracts/src/performance-script.ts)，生成的 Draft 2020-12 JSON Schema 是 [`schemas/performance-script.v1.json`](../schemas/performance-script.v1.json)。可执行示例在 [`content/performances/fountain-meeting.performance.json`](../content/performances/fountain-meeting.performance.json)。

## 执行语义

- `cast` 用稳定 `role_id` 关联 `character_id` 和 `outfit_id`。剧本 cue 只引用 role，不写 `uma_*` actor ID，也不直接引用 CharacterBundle；
- `scenes` 按数组顺序执行。每个 scene 指向一个已注册 `stage_id`，场景切换时用 `placements.spawn_id` 重建 Runtime；
- `beats` 按数组顺序执行；同一 beat 内所有 cue 同时启动，所以可以让两名角色并行行走，或让对白与移动同时发生；
- `wait_for: all` 等待该 beat 的移动、对白与 wait cue 全部到达终态；`none` 允许下一个 beat 与当前任务重叠，但离开 scene 前仍会收拢后台任务；
- `hold_ms` 是 beat 完成后的额外停顿；
- `actor.move_to` 只使用 Anchor 或另一个 role，不把模型生成的裸坐标写入剧本；
- camera cue 与角色命令分离。镜头不会修改世界状态；
- `spoken_text`、双语字幕、`audio_path` 与 `render_hints` 不影响 Stage 世界权威，只提供给 TTS/anime 适配器。

当前 cue 包括：

- `actor.move_to`、`actor.follow_activity_path`、`actor.follow`、`actor.stop_follow`、`actor.face`、`actor.stop`；
- `dialogue.say`、`narration.say`、`stage.wait`；
- `camera.follow_actor`、`camera.focus_actor`、`camera.focus_anchor`、`camera.focus_zone`、`camera.fixed`、`camera.overview`。

构建时不仅校验 JSON 形状，还会检查 cast 角色映射、服装、stage、spawn、anchor、zone 和 activity path。role、scene、beat、cue ID 必须唯一，所有 role 引用必须存在。

## 与 umamusume-anime 的适配关系

现有 anime structured script 可以按下列规则从 PerformanceScript 生成：

| PerformanceScript | umamusume-anime |
| --- | --- |
| `performance_id` | `projectId` |
| scene `render_hints.anime_background` | line/scene `background` |
| cast `role_id` | `speakerId` |
| cast `render_hints.anime_sprite/anime_scale` | `characters[].sprite/spriteScale` |
| placement `anime_slot` | `characters[].slot` |
| `dialogue.say.spoken_text` | `spokenText` |
| `subtitle_ja/subtitle_zh` | `subtitleJa/subtitleZh` |
| `audio_path` | `audio` |
| `narration.say` | `type: narration` line |

第一版 anime 适配器可以忽略行走路径，只在对白 beat 选择角色布局；后续再把 Stage 的移动/镜头 cue 映射为 Remotion 动画与剪辑。这样现有 TTS、audio QC、`director.py` 和 timeline 渲染都能保留，不需要让 anime 理解 StageRuntime。

## 与实时 Agent 的关系

Agent 模式继续直接返回 `AgentStageAction`，因为实时会话不需要先生成完整短剧。未来增加 Recorder 后，可以把一轮或多轮的对白、成功完成的 StageCommand、CameraCue 和场景切换记录成 beats，保存为 PerformanceScript，再交给人工编辑或 anime 渲染。录制时应只记录 `completed` 的确定性结果，失败动作写入执行报告而不是主剧本。

## 当前边界

- 网页示例执行器已支持多 scene 重载、并行 cue、任务等待和控制权归还，但尚无暂停、取消和逐 beat UI；
- scene 切换会按 placements 重新生成 cast，不保存留在旧地图的后台角色；这一点应由后续 `WorldRuntime` 解决；
- `render_hints` 是可选适配提示，不是核心语义。Stage 或 anime 缺少某项提示时，应通过各自的 asset/location manifest 补全，而不是把仓库绝对路径写进剧本。
