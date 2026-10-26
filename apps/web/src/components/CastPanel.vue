<script setup lang="ts">
import { computed } from "vue";
import type { CharacterAgentMappingEntry } from "@uma-stage/contracts";

interface CastSelection {
  characterId: string;
  outfit: "uniform" | "race_outfit";
}

const props = defineProps<{
  selections: CastSelection[];
  mappings: CharacterAgentMappingEntry[];
  activeActorId: string;
  activeCharacterName: string;
  agentCharacters: string[];
  agentEnabled: boolean;
  agentStatus: string;
  maxCast: number;
  ready: boolean;
  performanceRunning: boolean;
  activeActorFollowsPlayer: boolean;
  canControlActiveActor: boolean;
  actorLocations: Record<string, { sceneId: string; label: string }>;
}>();

const emit = defineEmits<{
  select: [actorId: string];
  add: [];
  remove: [index: number];
  "update-character": [index: number, characterId: string];
  "update-outfit": [index: number, outfit: CastSelection["outfit"]];
  approach: [];
  follow: [];
  "stop-follow": [];
}>();

const locked = computed(() => !props.ready || props.performanceRunning || props.agentStatus === "busy" || props.agentStatus === "connecting");
const actionLocked = computed(() => locked.value || !props.canControlActiveActor);

function mappingFor(characterId: string): CharacterAgentMappingEntry | undefined {
  return props.mappings.find((mapping) => mapping.character_id === characterId);
}
function available(mapping: CharacterAgentMappingEntry): boolean {
  return !props.agentEnabled || props.agentCharacters.length === 0 || props.agentCharacters.includes(mapping.agent_character_name);
}
function selectedElsewhere(characterId: string, index: number): boolean {
  return props.selections.some((selection, candidateIndex) => candidateIndex !== index && selection.characterId === characterId);
}
function updateCharacter(index: number, event: Event): void {
  emit("update-character", index, (event.target as HTMLSelectElement).value);
}
function updateOutfit(index: number, event: Event): void {
  emit("update-outfit", index, (event.target as HTMLSelectElement).value as CastSelection["outfit"]);
}
</script>

<template>
  <aside class="panel cast-panel" data-testid="cast-panel" aria-label="同行角色">
    <div class="panel-heading cast-heading">
      <div>
        <span class="section-kicker">同行角色</span>
        <h2>{{ selections.length }} 位角色在场</h2>
      </div>
      <button type="button" class="icon-button add-cast-button" :disabled="locked || selections.length >= maxCast" title="添加角色" aria-label="添加角色" @click="emit('add')">＋</button>
    </div>
    <p class="panel-intro">选择当前互动角色，或调整这次出行的服装。</p>

    <div class="cast-list">
      <article
        v-for="(member, index) in selections"
        :key="`${index}-${member.characterId}`"
        class="cast-card"
        :class="{ active: mappingFor(member.characterId)?.stage_actor_id === activeActorId }"
        :data-testid="`cast-card-${member.characterId}`"
        :data-location="actorLocations[mappingFor(member.characterId)?.stage_actor_id ?? '']?.sceneId"
      >
        <button
          type="button"
          class="cast-card-heading"
          :aria-pressed="mappingFor(member.characterId)?.stage_actor_id === activeActorId"
          @click="emit('select', mappingFor(member.characterId)?.stage_actor_id ?? '')"
        >
          <span class="cast-avatar" :class="`avatar-${index % 4}`" aria-hidden="true">{{ mappingFor(member.characterId)?.agent_character_name.slice(0, 1) }}</span>
          <span class="cast-card-name">
            <strong>{{ mappingFor(member.characterId)?.agent_character_name }}</strong>
            <small>{{ actorLocations[mappingFor(member.characterId)?.stage_actor_id ?? '']?.label ?? '等待入场' }}</small>
          </span>
          <span v-if="mappingFor(member.characterId)?.stage_actor_id === activeActorId" class="selected-check" aria-hidden="true">✓</span>
        </button>
        <div class="cast-fields">
          <label>
            <span>角色</span>
            <select :value="member.characterId" :disabled="locked" @change="updateCharacter(index, $event)">
              <option
                v-for="mapping in mappings"
                :key="mapping.character_id"
                :value="mapping.character_id"
                :disabled="!available(mapping) || selectedElsewhere(mapping.character_id, index)"
              >{{ mapping.agent_character_name }}{{ available(mapping) ? '' : '（未加载）' }}</option>
            </select>
          </label>
          <label>
            <span>服装</span>
            <select :value="member.outfit" :disabled="locked" @change="updateOutfit(index, $event)">
              <option value="uniform">制服</option>
              <option value="race_outfit">决胜服</option>
            </select>
          </label>
        </div>
        <button v-if="selections.length > 1" type="button" class="remove-cast-button" :disabled="locked" @click="emit('remove', index)">移出本次同行</button>
      </article>
    </div>

    <div class="actor-quick-actions">
      <div class="quick-actions-heading">
        <span>与 {{ activeCharacterName }} 互动</span>
        <small>{{ activeActorFollowsPlayer ? '正在跟随' : '等待指示' }}</small>
      </div>
      <div class="quick-action-grid">
        <button type="button" class="button subtle-button" data-testid="actor-approach" :disabled="actionLocked" @click="emit('approach')">过来</button>
        <button type="button" class="button subtle-button" data-testid="actor-follow" :disabled="actionLocked || activeActorFollowsPlayer" @click="emit('follow')">跟随</button>
        <button type="button" class="button subtle-button" data-testid="actor-stop-follow" :disabled="actionLocked || !activeActorFollowsPlayer" @click="emit('stop-follow')">停下</button>
      </div>
    </div>
  </aside>
</template>
