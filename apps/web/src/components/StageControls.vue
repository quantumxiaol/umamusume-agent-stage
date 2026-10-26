<script setup lang="ts">
import type { StageEnvironment, StageRegistryEntry } from "@uma-stage/contracts";

interface NamedLocation { id: string; displayName: string }
interface ActivityOption { id: string; activityId: string }

defineProps<{
  ready: boolean;
  busy: boolean;
  stageChoices: StageRegistryEntry[];
  activeStagePath: string;
  currentSceneId: string;
  currentPlayerActorId: string;
  activeActorId: string;
  activeCharacterName: string;
  sceneAnchors: NamedLocation[];
  sceneZones: NamedLocation[];
  activityPaths: ActivityOption[];
  environment: StageEnvironment;
  minimapVisible: boolean;
  mapOverviewActive: boolean;
  performanceRunning: boolean;
  performancePaused: boolean;
  performanceStatus: string;
  performanceBeatId: string | null;
}>();

const emit = defineEmits<{
  "change-stage": [definitionPath: string];
  "open-world": [];
  "toggle-minimap": [];
  "toggle-overview": [];
  "follow-camera": [actorId: string];
  "focus-zone": [zoneId: string];
  "focus-anchor": [anchorId: string];
  "send-actor-to": [anchorId: string, label: string];
  "run-activity": [pathId: string, activityId: string];
  "run-meeting": [];
  "update-environment": [patch: Partial<StageEnvironment>];
  "run-performance": [];
  "toggle-performance-pause": [];
  "cancel-performance": [];
  reset: [];
}>();

function changeStage(event: Event): void {
  emit("change-stage", (event.target as HTMLSelectElement).value);
}
function changeTime(event: Event): void {
  emit("update-environment", { time_of_day: (event.target as HTMLSelectElement).value as StageEnvironment["time_of_day"] });
}
function changeWeather(event: Event): void {
  emit("update-environment", { weather: (event.target as HTMLSelectElement).value as StageEnvironment["weather"] });
}
function changeIntensity(event: Event): void {
  emit("update-environment", { intensity: Number((event.target as HTMLInputElement).value) });
}
</script>

<template>
  <section class="stage-controls" aria-label="舞台控制">
    <div class="primary-control-row">
      <button type="button" class="button performance-button" :disabled="!ready || performanceRunning" @click="emit('run-performance')">
        {{ performanceRunning ? '短剧演出中' : '播放星光短剧' }}
      </button>
      <div v-if="performanceRunning" class="performance-playback" aria-label="演出播放控制">
        <button type="button" class="button subtle-button" :aria-pressed="performancePaused" @click="emit('toggle-performance-pause')">{{ performancePaused ? '继续' : '暂停' }}</button>
        <button type="button" class="button subtle-button" @click="emit('cancel-performance')">结束</button>
        <span role="status">{{ performancePaused ? '已暂停' : performanceStatus === 'loading' ? '正在加载素材' : `正在演出${performanceBeatId ? ` · ${performanceBeatId}` : ''}` }}</span>
      </div>
      <span v-else class="control-hint">现有配音与角色编排</span>
    </div>

    <div class="essential-controls">
      <div class="control-group scene-control">
        <span class="control-label">地点</span>
        <select :value="activeStagePath" :disabled="!ready || busy || performanceRunning" aria-label="切换地图" @change="changeStage">
          <option v-for="choice in stageChoices" :key="choice.stage_id" :value="choice.definition_path">{{ choice.display_name }}</option>
        </select>
        <button type="button" class="button subtle-button" aria-haspopup="dialog" aria-keyshortcuts="G" :disabled="!ready || busy || performanceRunning" title="快捷键 G" @click="emit('open-world')">校园路线</button>
      </div>
      <div class="control-group view-control">
        <span class="control-label">视野</span>
        <button type="button" class="button subtle-button" :aria-pressed="minimapVisible" aria-keyshortcuts="M" :disabled="!ready || performanceRunning" @click="emit('toggle-minimap')">小地图 {{ minimapVisible ? '开' : '关' }}</button>
        <button type="button" class="button subtle-button" :aria-pressed="mapOverviewActive" aria-keyshortcuts="O" :disabled="!ready || performanceRunning" @click="emit('toggle-overview')">{{ mapOverviewActive ? '退出全图' : '全图预览' }}</button>
      </div>
      <div class="control-group environment-control">
        <span class="control-label">环境</span>
        <select :value="environment.time_of_day" :disabled="!ready || performanceRunning" aria-label="时间" @change="changeTime">
          <option value="day">白天</option>
          <option value="evening">黄昏</option>
          <option value="night">夜晚</option>
        </select>
        <select :value="environment.weather" :disabled="!ready || performanceRunning" aria-label="天气" @change="changeWeather">
          <option value="clear">晴朗</option>
          <option value="rain">下雨</option>
          <option value="snow">下雪</option>
        </select>
      </div>
    </div>

    <details class="advanced-controls">
      <summary>镜头、活动与场景管理<span>展开更多控制</span></summary>
      <div class="advanced-control-content">
        <div v-if="environment.weather !== 'clear'" class="control-row">
          <span class="control-label">天气强度</span>
          <input :value="environment.intensity" type="range" min="0.15" max="1" step="0.05" aria-label="天气强度" :disabled="!ready || performanceRunning" @change="changeIntensity">
        </div>
        <div class="control-row">
          <span class="control-label">镜头</span>
          <button type="button" class="button subtle-button" :disabled="!ready || !currentPlayerActorId || performanceRunning" @click="emit('follow-camera', currentPlayerActorId)">跟随训练员</button>
          <button type="button" class="button subtle-button" :disabled="!ready || !activeActorId || performanceRunning" @click="emit('follow-camera', activeActorId)">跟随{{ activeCharacterName }}</button>
          <button v-for="zone in sceneZones.slice(0, 2)" :key="zone.id" type="button" class="button subtle-button" :disabled="!ready || performanceRunning" @click="emit('focus-zone', zone.id)">定镜 · {{ zone.displayName }}</button>
          <button v-if="sceneZones.length === 0 && sceneAnchors[0]" type="button" class="button subtle-button" :disabled="!ready || performanceRunning" @click="emit('focus-anchor', sceneAnchors[0].id)">定镜 · {{ sceneAnchors[0].displayName }}</button>
        </div>
        <div class="control-row">
          <span class="control-label">角色活动</span>
          <button v-for="anchor in sceneAnchors.slice(0, 3)" :key="anchor.id" type="button" class="button subtle-button" :disabled="!ready || busy || !activeActorId || performanceRunning" @click="emit('send-actor-to', anchor.id, anchor.displayName)">前往{{ anchor.displayName }}</button>
          <button v-for="path in activityPaths" :key="path.id" type="button" class="button subtle-button" :disabled="!ready || busy || !activeActorId || performanceRunning" @click="emit('run-activity', path.id, path.activityId)">{{ path.activityId }}</button>
          <button v-if="currentSceneId === 'tracen_student_plaza'" type="button" class="button subtle-button" :disabled="!ready || busy || !activeActorId || performanceRunning" @click="emit('run-meeting')">喷泉会面演出</button>
        </div>
        <div class="control-row scene-management">
          <span class="control-label">场景管理</span>
          <span>将当前角色队伍重新安置于此地图。</span>
          <button type="button" class="button danger-subtle-button" :disabled="!ready || busy || performanceRunning" @click="emit('reset')">重置场景</button>
        </div>
      </div>
    </details>
  </section>
</template>
