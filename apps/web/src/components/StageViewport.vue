<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  stageName: string;
  phase: string;
  message: string;
  error: string;
  transitionImage: string;
}>();

const emit = defineEmits<{ retry: [] }>();
const stageElement = ref<HTMLElement | null>(null);

function getMountElement(): HTMLElement | null {
  return stageElement.value;
}

defineExpose({ getMountElement });
</script>

<template>
  <section class="stage-card" aria-label="角色舞台">
    <div class="stage-meta">
      <div class="stage-live-label">
        <span class="live-indicator" :class="phase" aria-hidden="true"></span>
        <strong>校园实况</strong>
      </div>
      <div class="key-guide" aria-label="移动操作">
        <span class="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
        <span>或方向键移动训练员</span>
      </div>
    </div>
    <div ref="stageElement" class="stage-mount" data-testid="stage-viewport" :aria-label="`${stageName}舞台`">
      <div v-if="phase === 'loading' && transitionImage" class="stage-transition" role="status">
        <img :src="transitionImage" alt="" aria-hidden="true">
        <div class="stage-transition-badge">
          <span class="loading-spinner" aria-hidden="true"></span>
          <span>{{ message }}</span>
        </div>
      </div>
      <div v-if="phase === 'loading' && !transitionImage" class="stage-overlay loading-panel" role="status">
        <span class="loading-spinner" aria-hidden="true"></span>
        <strong>正在布置校园舞台</strong>
        <span>{{ message }}</span>
      </div>
      <div v-if="phase === 'error'" class="stage-overlay error-panel" role="alert">
        <strong>舞台暂时未能装载</strong>
        <span>{{ error }}</span>
        <button type="button" class="button primary-button" @click="emit('retry')">重新装载</button>
      </div>
    </div>
  </section>
</template>
