<script setup lang="ts">
import { computed } from "vue";
import type { StageActorState, StageEvent } from "@uma-stage/contracts";

interface ActorPresentation {
  instanceId: string;
  displayName: string;
  player: boolean;
  initials: string;
}
interface ConversationLine {
  id: string;
  speaker: string;
  text: string;
  kind: string;
}

const props = defineProps<{
  actors: ActorPresentation[];
  actorStates: StageActorState[];
  events: StageEvent[];
  conversation: ConversationLine[];
}>();

const reversedEvents = computed(() => [...props.events].reverse());
const commandLines = computed(() => props.conversation.filter((line) => line.kind === "command"));
function stateFor(actorId: string): StageActorState | undefined {
  return props.actorStates.find((state) => state.actor_id === actorId);
}
</script>

<template>
  <details class="panel diagnostics-panel">
    <summary>
      <span>舞台状态与调试信息</span>
      <small>{{ actors.length }} 名 Actor · {{ events.length }} 条事件</small>
    </summary>
    <div class="diagnostics-content">
      <section>
        <h2>Actor 快照</h2>
        <article
          v-for="view in actors"
          :key="view.instanceId"
          class="actor-diagnostic-row"
          :data-testid="`actor-${view.instanceId}`"
          :data-x="stateFor(view.instanceId)?.position.x"
          :data-y="stateFor(view.instanceId)?.position.y"
          :data-speech="stateFor(view.instanceId)?.speech ?? ''"
        >
          <strong>{{ view.displayName }}</strong>
          <span>{{ stateFor(view.instanceId)?.control_owner ?? '—' }} · {{ stateFor(view.instanceId)?.locomotion ?? '—' }}/{{ stateFor(view.instanceId)?.facing ?? '—' }}</span>
          <code>{{ stateFor(view.instanceId) ? `${Math.round(stateFor(view.instanceId)!.position.x)}, ${Math.round(stateFor(view.instanceId)!.position.y)}` : '—' }}</code>
        </article>
      </section>
      <section v-if="commandLines.length > 0">
        <h2>StageCommand</h2>
        <ol class="diagnostic-list">
          <li v-for="line in commandLines" :key="line.id"><span>{{ line.text }}</span></li>
        </ol>
      </section>
      <section>
        <h2>最近事件</h2>
        <ol class="diagnostic-list event-list">
          <li v-for="event in reversedEvents" :key="event.sequence">
            <span>{{ String(event.sequence).padStart(2, '0') }} · {{ actors.find((actor) => actor.instanceId === event.actor_id)?.displayName ?? 'stage' }} · {{ event.type }}</span>
            <time>{{ (event.time_ms / 1000).toFixed(1) }}s</time>
          </li>
          <li v-if="events.length === 0">等待舞台事件</li>
        </ol>
      </section>
    </div>
  </details>
</template>
