import { defineStore } from "pinia";

import type { StageEvent, StageSnapshot } from "@uma-stage/contracts";

export const useStageStore = defineStore("stage", {
  state: () => ({
    phase: "loading" as "loading" | "ready" | "error",
    message: "正在装载 ScenePack 与 ActorBundle…",
    error: "",
    snapshot: null as StageSnapshot | null,
    events: [] as StageEvent[],
  }),
  actions: {
    reset(): void {
      this.phase = "loading";
      this.message = "正在装载 ScenePack 与 ActorBundle…";
      this.error = "";
      this.snapshot = null;
      this.events = [];
    },
    ready(): void {
      this.phase = "ready";
      this.message = "舞台已就绪";
    },
    fail(error: unknown): void {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
      this.message = "舞台装载失败";
    },
    setMessage(message: string): void {
      this.message = message;
    },
    setSnapshot(snapshot: StageSnapshot): void {
      this.snapshot = snapshot;
    },
    pushEvent(event: StageEvent): void {
      this.events = [...this.events.slice(-11), event];
    },
  },
});
