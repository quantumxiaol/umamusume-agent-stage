import { afterEach, describe, expect, it, vi } from "vitest";
import { performanceScriptSchema, type PerformanceScript } from "@uma-stage/contracts";
import { RuntimeTask } from "./task";
import { ShowRunner, type ShowAdapter } from "./show-runner";

function script(beats: unknown[]): PerformanceScript {
  return performanceScriptSchema.parse({ schema_version: "performance_script.v1", performance_id: "test", title: "Test", cast: [{ role_id: "a", character_id: "a" }], scenes: [{ scene_id: "scene", stage_id: "stage", beats }] });
}

function adapter(overrides: Partial<ShowAdapter> = {}): ShowAdapter {
  return {
    prepare: vi.fn(async () => {}), enterScene: vi.fn(async () => {}),
    executeCue: vi.fn(async (_script, cue, context) => {
      if (cue.type === "stage.wait") await context.wait(cue.duration_ms);
    }),
    setPaused: vi.fn(), cleanup: vi.fn(), ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("ShowRunner", () => {
  it("waits for an asynchronous camera cue before starting the next beat", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const host = adapter({ executeCue: async (_script, cue, context) => {
      order.push(cue.cue_id);
      if (cue.type === "camera.overview") await context.wait(1000);
    } });
    const runner = new ShowRunner();
    const done = runner.run(async () => script([
      { beat_id: "camera", cues: [{ cue_id: "pan", type: "camera.overview" }] },
      { beat_id: "dialogue", cues: [{ cue_id: "line", type: "dialogue.say", role_id: "a", text: "Ready" }] },
    ]), host);
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual(["pan"]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).status).toBe("completed");
    expect(order).toEqual(["pan", "line"]);
    expect(host.cleanup).toHaveBeenCalledOnce();
  });

  it("pauses waits without consuming the remaining duration", async () => {
    vi.useFakeTimers();
    const runner = new ShowRunner();
    const host = adapter();
    const done = runner.run(async () => script([{ beat_id: "wait", cues: [{ cue_id: "wait", type: "stage.wait", duration_ms: 1000 }] }]), host);
    await vi.advanceTimersByTimeAsync(400);
    await runner.setPaused(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner.state.status).toBe("paused");
    await runner.setPaused(false);
    await vi.advanceTimersByTimeAsync(599);
    expect(runner.state.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).status).toBe("completed");
    expect(host.setPaused).toHaveBeenNthCalledWith(1, true);
    expect(host.setPaused).toHaveBeenNthCalledWith(2, false);
  });

  it("cancels running tasks and paused waits, cleans up, and can run again", async () => {
    vi.useFakeTimers();
    const task = new RuntimeTask("move");
    task.start();
    const runner = new ShowRunner();
    const host = adapter({ executeCue: async (_script, cue, context) => {
      if (cue.type === "stage.wait") await context.wait(cue.duration_ms);
      else await context.task(task);
    } });
    const done = runner.run(async () => script([{ beat_id: "parallel", cues: [
      { cue_id: "wait", type: "stage.wait", duration_ms: 5000 },
      { cue_id: "move", type: "actor.stop", role_id: "a" },
    ] }]), host);
    await vi.advanceTimersByTimeAsync(10);
    await runner.setPaused(true);
    runner.cancel();
    expect((await done).status).toBe("cancelled");
    expect(task.status).toBe("cancelled");
    expect(host.cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const again = runner.run(async () => script([{ beat_id: "again", cues: [{ cue_id: "wait", type: "stage.wait", duration_ms: 5 }] }]), adapter());
    await vi.advanceTimersByTimeAsync(5);
    expect((await again).status).toBe("completed");
  });

  it("handles wait_for:none failures immediately and aborts sibling tasks", async () => {
    vi.useFakeTimers();
    const task = new RuntimeTask("sibling"); task.start();
    const runner = new ShowRunner();
    const host = adapter({ executeCue: async (_script, cue, context) => {
      if (cue.cue_id === "bad") { await context.wait(50); throw new Error("missing audio"); }
      await context.task(task);
    } });
    const done = runner.run(async () => script([
      { beat_id: "background", wait_for: "none", cues: [{ cue_id: "bad", type: "actor.stop", role_id: "a" }] },
      { beat_id: "foreground", cues: [{ cue_id: "pending", type: "actor.stop", role_id: "a" }] },
    ]), host);
    await vi.advanceTimersByTimeAsync(50);
    expect(await done).toMatchObject({ status: "failed", error: "scene/background/bad: missing audio" });
    expect(task.status).toBe("cancelled");
    expect(host.cleanup).toHaveBeenCalledOnce();
  });

  it("does not enter a scene when loading finishes while paused or cancelled", async () => {
    vi.useFakeTimers();
    let finishLoad!: (value: PerformanceScript) => void;
    const runner = new ShowRunner();
    const host = adapter();
    const done = runner.run(() => new Promise((resolve) => { finishLoad = resolve; }), host);
    await runner.setPaused(true);
    finishLoad(script([{ beat_id: "wait", cues: [{ cue_id: "wait", type: "stage.wait", duration_ms: 5 }] }]));
    await vi.advanceTimersByTimeAsync(10);
    expect(host.prepare).not.toHaveBeenCalled();
    runner.cancel();
    expect((await done).status).toBe("cancelled");
    expect(host.enterScene).not.toHaveBeenCalled();
  });

  it("does not leave tracked commands running when one cue fails synchronously", async () => {
    const task = new RuntimeTask("sibling"); task.start();
    const runner = new ShowRunner();
    const done = runner.run(async () => script([{ beat_id: "parallel", cues: [
      { cue_id: "pending", type: "actor.stop", role_id: "a" },
      { cue_id: "bad", type: "actor.stop", role_id: "a" },
    ] }]), adapter({ executeCue: async (_script, cue, context) => {
      if (cue.cue_id === "bad") throw new Error("invalid slot");
      await context.task(task);
    } }));
    expect((await done).status).toBe("failed");
    expect(task.status).toBe("cancelled");
  });
});
