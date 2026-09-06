<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { connectionKey, portalLocation, worldGraph, type WorldOverviewData } from "./world-overview";

const props = defineProps<{
  data: WorldOverviewData | null;
  currentSceneId: string;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{ close: []; retry: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const selectedSceneId = ref(props.currentSceneId);
const selectedExitId = ref<string | null>(null);
const graph = computed(() => props.data ? worldGraph(props.data) : null);
const currentScene = computed(() => props.data?.scenes.get(props.currentSceneId));
const selectedScene = computed(() => props.data?.scenes.get(selectedSceneId.value));
const route = computed(() => {
  if (!props.data || !currentScene.value || !selectedScene.value) return null;
  const exit = currentScene.value.portals.find((portal) => portal.id === selectedExitId.value && portal.target_scene_id === selectedSceneId.value);
  if (exit) return { steps: [{ from_scene_id: props.currentSceneId, portal_id: exit.id, exit_position: exit.position, target_scene_id: exit.target_scene_id, target_spawn_id: exit.target_spawn_id }] };
  return props.data.navigation.findRoute(props.currentSceneId, selectedSceneId.value);
});
const routeEdges = computed(() => new Set(route.value?.steps.map((step) => connectionKey(step.from_scene_id, step.target_scene_id))));
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => {
  dialog.value?.close();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});

function sceneName(id: string): string {
  return props.data?.world.locations.find((location) => location.scene_id === id)?.display_name ?? id;
}

function selectDestination(id: string, exitId: string | null = null): void {
  selectedSceneId.value = id;
  selectedExitId.value = exitId;
}

function exitLocation(sceneId: string, position: { x: number; y: number }): string {
  const scene = props.data?.scenes.get(sceneId);
  return `${scene ? portalLocation(scene, position) : "出口"} · 格子 (${position.x}, ${position.y})`;
}

function handleKey(event: KeyboardEvent): void {
  if (event.key === "Escape" || (event.key.toLowerCase() === "g" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat)) {
    event.preventDefault();
    emit("close");
  }
  // Keep movement and map shortcuts out of the stage while this modal owns focus.
  event.stopPropagation();
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="world-overview" aria-labelledby="world-overview-title" @cancel.prevent="emit('close')" @keydown="handleKey" @click="(event) => { if (event.target === dialog) emit('close'); }">
      <header class="world-overview-heading">
        <div>
          <span class="eyebrow">WORLD · 场景连接</span>
          <h2 id="world-overview-title">世界连接总览</h2>
          <p>连接示意，不代表实际距离或出口方向。点选地点查看路线，不会传送角色。</p>
        </div>
        <button type="button" autofocus aria-label="关闭世界连接总览" @click="emit('close')">关闭 · Esc</button>
      </header>
      <p v-if="loading" role="status">正在读取地图与传送点…</p>
      <div v-else-if="error" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="emit('retry')">重新加载世界地图</button>
      </div>
      <template v-else-if="graph && data">
        <div class="world-legend">
          <span class="world-current-key">● 当前位置：{{ sceneName(currentSceneId) }}</span>
          <span class="world-route-key">● 选中目的地 / 路线</span>
          <span>{{ graph.nodes.length }} 张地图 · 连线表示 Portal 相通，箭头表示单向</span>
        </div>
        <div class="world-graph-scroll" tabindex="0" aria-label="世界地图，可横向滚动">
          <svg class="world-graph" :viewBox="`0 0 ${graph.width} ${graph.height}`" :style="{ aspectRatio: `${graph.width} / ${graph.height}` }" role="group" aria-label="地图连接，选择一个地点查看从当前位置出发的路线">
            <defs>
              <marker id="world-one-way" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a5c8ba" /></marker>
            </defs>
            <g aria-hidden="true">
              <path v-for="edge in graph.edges" :key="edge.key" :class="['world-edge', { routed: routeEdges.has(edge.key) }]"
                :d="`M ${edge.from.x} ${edge.from.y} L ${(edge.from.x + edge.to.x) / 2} ${(edge.from.y + edge.to.y) / 2} L ${edge.to.x} ${edge.to.y}`"
                :marker-mid="edge.bidirectional ? undefined : 'url(#world-one-way)'" />
            </g>
            <g v-for="node in graph.nodes" :key="node.id" :transform="`translate(${node.x}, ${node.y})`"
              :class="['world-node', { current: node.id === currentSceneId, selected: node.id === selectedSceneId }]"
              role="button" tabindex="0" :aria-pressed="node.id === selectedSceneId" :aria-label="`${node.name}${node.id === currentSceneId ? '，当前位置' : '，查看路线'}`"
              @click="selectDestination(node.id)" @keydown.enter.prevent="selectDestination(node.id)" @keydown.space.prevent="selectDestination(node.id)">
              <rect x="-78" y="-27" width="156" height="54" rx="10" />
              <text text-anchor="middle" y="-2">{{ node.name }}</text>
              <text class="world-node-caption" text-anchor="middle" y="16">{{ node.id === currentSceneId ? '你在这里' : node.id === selectedSceneId ? '目的地' : '查看路线' }}</text>
            </g>
          </svg>
        </div>
        <div class="world-details">
          <section aria-labelledby="world-exits-title">
            <h3 id="world-exits-title">当前位置的出口</h3>
            <p v-if="!currentScene?.portals.length">当前地图没有可用出口。</p>
            <div class="world-exits">
              <button v-for="portal in currentScene?.portals" :key="portal.id" type="button" @click="selectDestination(portal.target_scene_id, portal.id)">
                <strong>前往 {{ sceneName(portal.target_scene_id) }}</strong>
                <span>{{ exitLocation(currentSceneId, portal.position) }}</span>
              </button>
            </div>
          </section>
          <section aria-labelledby="world-route-title" aria-live="polite">
            <h3 id="world-route-title">{{ sceneName(currentSceneId) }} → {{ sceneName(selectedSceneId) }}</h3>
            <p v-if="selectedSceneId === currentSceneId">你已在这里。选择其他地点，查看最少换图路线。</p>
            <p v-else-if="!route">暂无可用的传送点路线。</p>
            <template v-else>
              <p>最少换图 {{ route.steps.length }} 次 · 请按顺序走到各图出口</p>
              <ol class="world-route-steps">
                <li v-for="step in route.steps" :key="`${step.from_scene_id}-${step.portal_id}`">
                  <strong>{{ sceneName(step.from_scene_id) }} → {{ sceneName(step.target_scene_id) }}</strong>
                  <span>{{ exitLocation(step.from_scene_id, step.exit_position) }}</span>
                </li>
              </ol>
            </template>
          </section>
        </div>
        <footer class="world-overview-footer">格子坐标从左上角 (0, 0) 开始，x 向右、y 向下；不是人物列表中的像素坐标。总览只供查路，不改变角色位置、跟随关系或当前镜头。</footer>
      </template>
    </dialog>
  </Teleport>
</template>

<style scoped>
.world-overview { width: min(1440px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); padding: 24px; border: 1px solid #527366; border-radius: 18px; background: #10231c; color: #e0eade; box-shadow: 0 24px 100px #0009; }
.world-overview::backdrop { background: #030d0bbd; backdrop-filter: blur(4px); }
.world-overview-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
h2 { margin: 6px 0; font-size: 26px; }
h3 { margin: 0 0 12px; font-size: 16px; }
p { margin: 8px 0 16px; color: #adc2b7; font-size: 13px; line-height: 1.7; }
.world-overview-heading button { flex: 0 0 auto; }
.world-legend { display: flex; flex-wrap: wrap; gap: 12px 22px; margin: 12px 0; font-size: 12px; color: #a4b7ad; }
.world-current-key { color: #79e1b0; }
.world-route-key { color: #f0cc84; }
.world-graph-scroll { overflow: auto; border: 1px solid #355449; border-radius: 12px; background: radial-gradient(ellipse at 20% 35%, #1d3a2e, #0b1914); }
.world-graph { display: block; width: 100%; min-width: 1040px; }
.world-edge { stroke: #517565; stroke-width: 3; fill: none; }
.world-edge.routed { stroke: #e9bd73; stroke-width: 5; }
.world-node { cursor: pointer; outline: none; }
.world-node rect { fill: #1b342a; stroke: #537e69; stroke-width: 1.5; }
.world-node text { fill: #e2eadf; font-size: 13px; pointer-events: none; }
.world-node .world-node-caption { fill: #99b4a5; font-size: 10px; }
.world-node.selected rect { fill: #463b25; stroke: #f0cc84; stroke-width: 2.5; }
.world-node.current rect { fill: #204c39; stroke: #79e1b0; stroke-width: 2.5; }
.world-node:hover rect, .world-node:focus-visible rect { stroke: #fff; stroke-width: 3; }
.world-details { display: grid; grid-template-columns: 1fr 1.3fr; gap: 26px; margin-top: 22px; }
.world-exits { display: grid; gap: 8px; }
.world-exits button { display: grid; gap: 4px; text-align: left; }
.world-exits strong, .world-route-steps strong { font-size: 13px; }
.world-exits span, .world-route-steps span { display: block; font-size: 12px; color: #adc2b7; line-height: 1.8; }
.world-route-steps { margin: 0; padding-left: 24px; }
.world-route-steps li { padding: 0 0 12px 4px; }
.world-route-steps li::marker { color: #f0cc84; }
.world-overview-footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid #355449; color: #94aca0; font-size: 12px; line-height: 1.7; }
@media (max-width: 720px) { .world-overview { padding: 16px; } .world-details { grid-template-columns: 1fr; } .world-overview-heading { gap: 10px; } h2 { font-size: 22px; } }
</style>
