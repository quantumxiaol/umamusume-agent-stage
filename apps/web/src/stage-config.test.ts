import { describe, expect, it } from "vitest";
import { resolveStageConfig } from "./stage-config";

describe("Stage deployment mode", () => {
  it("keeps local development in Agent mode", () => {
    expect(resolveStageConfig({})).toEqual({ mode: "agent", agentUrl: "http://127.0.0.1:1111", agentApiKey: "" });
    expect(resolveStageConfig({ UMAMUSUME_AGENT_URL: "https://example.hf.space", UMAMUSUME_AGENT_API_ACCESS_KEY: "configured-key" }).agentApiKey).toBe("configured-key");
  });

  it("defaults production to a playground even when Agent credentials exist", () => {
    expect(resolveStageConfig({ UMAMUSUME_AGENT_URL: "https://example.hf.space", UMAMUSUME_AGENT_API_ACCESS_KEY: "must-not-ship" }, true))
      .toEqual({ mode: "playground", agentUrl: "", agentApiKey: "" });
  });

  it("strips both credential naming variants in explicit playground builds", () => {
    expect(resolveStageConfig({
      VITE_STAGE_MODE: "playground",
      UMAMUSUME_AGENT_URL: "https://example.hf.space",
      UMAMUSUME_AGENT_API_ACCESS_KEY: "must-not-ship",
      VITE_UMAMUSUME_AGENT_URL: "https://fallback.hf.space",
      VITE_UMAMUSUME_AGENT_API_ACCESS_KEY: "must-not-ship-either",
    })).toEqual({ mode: "playground", agentUrl: "", agentApiKey: "" });
  });

  it("allows Agent production only when explicitly enabled", () => {
    expect(resolveStageConfig({ VITE_STAGE_MODE: "agent", VITE_UMAMUSUME_AGENT_URL: "https://example.hf.space", VITE_UMAMUSUME_AGENT_API_ACCESS_KEY: "key" }, true))
      .toEqual({ mode: "agent", agentUrl: "https://example.hf.space", agentApiKey: "key" });
  });

  it("rejects misspelled modes rather than accidentally enabling requests", () => {
    expect(() => resolveStageConfig({ VITE_STAGE_MODE: "off" })).toThrow("VITE_STAGE_MODE");
  });
});
