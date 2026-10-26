<script setup lang="ts">
defineProps<{
  stageName: string;
  phase: string;
  message: string;
  agentEnabled: boolean;
  agentStatus: string;
}>();
</script>

<template>
  <header class="app-header">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true">US</span>
      <div>
        <span class="brand-name">UMA STAGE</span>
        <span class="brand-subtitle">特雷森校园舞台</span>
      </div>
    </div>
    <div class="header-location">
      <span class="section-kicker">当前地点</span>
      <h1>{{ stageName }}</h1>
    </div>
    <div class="header-status">
      <span class="mode-pill" :class="agentEnabled ? agentStatus : 'connected'">
        <span class="status-dot" aria-hidden="true"></span>
        {{ agentEnabled ? 'Agent 对话' : '纯前端试玩' }}
      </span>
      <span class="stage-health" :class="phase" role="status">{{ message }}</span>
    </div>
  </header>
</template>
