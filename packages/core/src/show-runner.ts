import type { PerformanceCue, PerformanceScript } from "@uma-stage/contracts";
import type { StageTask } from "./task";

export type ShowStatus = "idle" | "loading" | "running" | "paused" | "completed" | "cancelled" | "failed";
export interface ShowState {
  status: ShowStatus;
  sceneId: string | null;
  beatId: string | null;
  error: string | null;
}

/** The host owns rendering/audio. The runner owns sequencing and cancellation. */
export interface ShowContext {
  readonly signal: AbortSignal;
  checkpoint(): Promise<void>;
  guard<T>(operation: Promise<T>): Promise<T>;
  wait(durationMs: number): Promise<void>;
  task(task: StageTask): Promise<void>;
}

export interface ShowAdapter {
  prepare(script: PerformanceScript, context: ShowContext): Promise<void>;
  enterScene(script: PerformanceScript, scene: PerformanceScript["scenes"][number], context: ShowContext): Promise<void>;
  executeCue(script: PerformanceScript, cue: PerformanceCue, context: ShowContext): Promise<void>;
  setPaused(paused: boolean): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

class ShowCancelled extends Error {}
interface Waiter {
  remainingMs: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve(): void;
}

export class ShowRunner {
  #state: ShowState = { status: "idle", sceneId: null, beatId: null, error: null };
  #controller: AbortController | null = null;
  #adapter: ShowAdapter | null = null;
  #paused = false;
  #finishing = false;
  #resume: (() => void) | null = null;
  #resumePromise: Promise<void> = Promise.resolve();
  readonly #waiters = new Set<Waiter>();

  constructor(private readonly onState: (state: ShowState) => void = () => {}) {}

  get state(): ShowState { return { ...this.#state }; }

  cancel(reason = "演出已取消"): void {
    this.#controller?.abort(new ShowCancelled(reason));
  }

  async setPaused(paused: boolean): Promise<void> {
    if (!this.#controller || this.#finishing || this.#controller.signal.aborted || this.#paused === paused) return;
    this.#paused = paused;
    if (paused) {
      if (!this.#resume) this.#resumePromise = new Promise((resolve) => { this.#resume = resolve; });
      for (const waiter of this.#waiters) {
        if (waiter.timer === null) continue;
        clearTimeout(waiter.timer);
        waiter.timer = null;
        waiter.remainingMs = Math.max(0, waiter.remainingMs - (performance.now() - waiter.startedAt));
      }
    }
    this.update({ status: paused ? "paused" : (this.#state.sceneId ? "running" : "loading") });
    try {
      await this.#adapter?.setPaused(paused);
      if (!this.#paused) {
        for (const waiter of this.#waiters) if (waiter.timer === null) this.schedule(waiter);
        this.#resume?.();
        this.#resume = null;
      }
    } catch (error) {
      this.#controller?.abort(error);
    }
  }

  async run(load: (context: ShowContext) => Promise<PerformanceScript>, adapter: ShowAdapter): Promise<ShowState> {
    if (this.#controller) throw new Error("A show is already running");
    const controller = new AbortController();
    this.#controller = controller;
    this.#adapter = adapter;
    this.#paused = false;
    this.#finishing = false;
    this.update({ status: "loading", sceneId: null, beatId: null, error: null });
    const signal = controller.signal;
    const context: ShowContext = {
      signal,
      checkpoint: async () => {
        signal.throwIfAborted();
        while (this.#paused) await abortable(this.#resumePromise, signal);
        signal.throwIfAborted();
      },
      guard: async <T>(operation: Promise<T>): Promise<T> => {
        const value = await abortable(operation, signal);
        await context.checkpoint();
        return value;
      },
      wait: async (durationMs) => {
        await context.checkpoint();
        let waiter!: Waiter;
        const completion = new Promise<void>((resolve) => {
          waiter = { remainingMs: durationMs, startedAt: 0, timer: null, resolve };
          this.#waiters.add(waiter);
          this.schedule(waiter);
        });
        try { await context.guard(completion); }
        finally {
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
        }
      },
      task: async (task) => {
        const cancel = () => task.cancel("Show interrupted");
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          const result = await context.guard(task.completion);
          if (result.status !== "completed") throw new Error(`${task.id}: ${result.error?.code ?? result.status} · ${result.error?.message ?? "动作未完成"}`);
        } finally { signal.removeEventListener("abort", cancel); }
      },
    };
    let terminal: ShowStatus = "completed";
    let message: string | null = null;
    try {
      const script = await context.guard(load(context));
      await context.guard(adapter.prepare(script, context));
      for (const scene of script.scenes) {
        await context.checkpoint();
        this.update({ status: "running", sceneId: scene.scene_id, beatId: null });
        await context.guard(adapter.enterScene(script, scene, context));
        const background: Promise<void>[] = [];
        for (const beat of scene.beats) {
          await context.checkpoint();
          this.update({ beatId: beat.beat_id });
          const tasks = beat.cues.map(async (cue) => {
            try {
              await context.checkpoint();
              await context.guard(adapter.executeCue(script, cue, context));
            } catch (error) {
              // Attach a handler immediately, including wait_for:none work.
              // One failed cue aborts its siblings and prevents the next beat.
              if (!signal.aborted) controller.abort(new Error(`${scene.scene_id}/${beat.beat_id}/${cue.cue_id}: ${errorMessage(error)}`));
            }
          });
          if (beat.wait_for === "all") await context.guard(Promise.all(tasks));
          else background.push(...tasks);
          if (beat.hold_ms > 0) await context.wait(beat.hold_ms);
        }
        await context.guard(Promise.all(background));
      }
    } catch (error) {
      terminal = error instanceof ShowCancelled ? "cancelled" : "failed";
      message = errorMessage(error);
      if (!signal.aborted) controller.abort(error);
    } finally {
      this.#finishing = true;
      for (const waiter of this.#waiters) if (waiter.timer !== null) clearTimeout(waiter.timer);
      this.#waiters.clear();
      this.#paused = false;
      this.#resume?.();
      this.#resume = null;
      try { await adapter.cleanup(); }
      catch (error) { terminal = "failed"; message = `Cleanup: ${errorMessage(error)}`; }
      this.#controller = null;
      this.#adapter = null;
      this.#finishing = false;
      this.update({ status: terminal, error: message });
    }
    return this.state;
  }

  private schedule(waiter: Waiter): void {
    waiter.startedAt = performance.now();
    waiter.timer = setTimeout(waiter.resolve, Math.max(0, waiter.remainingMs));
  }

  private update(change: Partial<ShowState>): void {
    this.#state = { ...this.#state, ...change };
    this.onState(this.state);
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
