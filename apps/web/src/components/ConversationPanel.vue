<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

interface ConversationLine {
  id: string;
  speaker: string;
  text: string;
  kind: "trainer" | "character" | "action" | "command" | "narrator" | "system";
}

const props = defineProps<{
  agentEnabled: boolean;
  agentStatus: string;
  agentStatusMessage: string;
  conversation: ConversationLine[];
  modelValue: string;
  castNames: string;
  performanceRunning: boolean;
  canRetryTurn: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  send: [];
  retry: [];
  cancel: [];
}>();

const conversationElement = ref<HTMLOListElement | null>(null);
const visibleLines = computed(() => props.conversation.filter((line) => line.kind !== "command"));
const busy = computed(() => props.agentStatus === "busy" || props.agentStatus === "connecting");
const statusLabel = computed(() => ({
  connected: "会话已就绪",
  connecting: "正在连接",
  busy: "正在演出回复",
  error: "连接需要处理",
  disconnected: "尚未连接",
}[props.agentStatus] ?? "等待连接"));

watch(
  () => [props.conversation.length, props.agentStatus],
  async () => {
    await nextTick();
    const element = conversationElement.value;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  },
);
</script>

<template>
  <section class="panel conversation-panel" aria-label="角色对话">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">{{ agentEnabled ? '角色对话' : '校园手册' }}</span>
        <h2>{{ agentEnabled ? '和她们说说话' : '在特雷森走走' }}</h2>
      </div>
      <span v-if="agentEnabled" class="conversation-state" :class="agentStatus">{{ statusLabel }}</span>
    </div>

    <template v-if="agentEnabled">
      <div class="conversation-context">
        <span>当前出演</span>
        <strong>{{ castNames || '等待角色入场' }}</strong>
      </div>
      <div class="agent-status-row" :class="agentStatus" role="status">
        <span>{{ agentStatusMessage }}</span>
        <button v-if="agentStatus === 'error' || agentStatus === 'disconnected'" type="button" class="text-button" @click="emit('retry')">{{ canRetryTurn ? '重连并重发' : '重新连接' }}</button>
      </div>
      <ol ref="conversationElement" class="conversation-list" aria-label="对话记录">
        <li v-for="line in visibleLines" :key="line.id" :class="line.kind">
          <strong>{{ line.speaker }}</strong>
          <span>{{ line.text }}</span>
        </li>
        <li v-if="visibleLines.length === 0" class="conversation-empty">
          <span class="empty-title">这一刻，由你开场。</span>
          <span>邀请角色过来、一起散步，或只是打个招呼。她们会回应，也会在舞台上行动起来。</span>
        </li>
        <li v-if="agentStatus === 'busy'" class="typing-line" aria-label="角色正在思考">
          <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>角色正在组织语言与动作</span>
        </li>
      </ol>
      <form class="agent-compose" @submit.prevent="emit('send')">
        <label for="agent-message">训练员</label>
        <textarea
          id="agent-message"
          :value="modelValue"
          rows="3"
          :disabled="busy || performanceRunning"
          placeholder="例如：织姬，过来和我聊聊吧。"
          @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
          @keydown.enter.exact.prevent="emit('send')"
        ></textarea>
        <div class="compose-footer">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <button v-if="agentStatus === 'busy'" type="button" class="button subtle-button" @click="emit('cancel')">取消本轮</button>
          <button v-else type="submit" class="button primary-button" :disabled="!modelValue.trim() || performanceRunning || agentStatus === 'connecting'">发送</button>
        </div>
      </form>
    </template>

    <template v-else>
      <div class="playground-note">
        <strong>自由探索，不调用 AI</strong>
        <p>选择一名同行角色，让她来到身边或跟随训练员。这个版本的所有移动与演出都在浏览器中完成。</p>
      </div>
      <ul class="playground-guide">
        <li><kbd>W A S D</kbd><span>移动训练员，方向键也可以。</span></li>
        <li><kbd>M</kbd><span>显示或隐藏小地图。</span></li>
        <li><kbd>O</kbd><span>预览当前地图全貌。</span></li>
        <li><kbd>G</kbd><span>查看校园各处的连接路线。</span></li>
      </ul>
      <div class="playground-tip">
        <strong>一起去别处看看</strong>
        <p>走到地图中标注目的地的传送点即可换图。只有正在跟随的角色会同行，其他角色会留在原处等你回来。</p>
      </div>
    </template>

    <template v-if="!agentEnabled && conversation.length > 0">
      <div class="performance-subtitle-heading">演出字幕</div>
      <ol class="conversation-list performance-conversation" aria-label="演出字幕">
        <li v-for="line in visibleLines" :key="line.id" :class="line.kind">
          <strong>{{ line.speaker }}</strong>
          <span>{{ line.text }}</span>
        </li>
      </ol>
    </template>
  </section>
</template>
