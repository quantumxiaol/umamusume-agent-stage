export interface StageConfig {
  mode: "playground" | "agent";
  agentUrl: string;
  agentApiKey: string;
}

/** Build-time allowlist: a playground must not inherit any Agent credentials. */
export function resolveStageConfig(
  environment: Record<string, string | undefined>,
  production = false,
): StageConfig {
  const mode = environment.VITE_STAGE_MODE?.trim() || (production ? "playground" : "agent");
  if (mode !== "playground" && mode !== "agent") {
    throw new Error("VITE_STAGE_MODE 必须为 playground 或 agent");
  }
  if (mode === "playground") return { mode, agentUrl: "", agentApiKey: "" };
  return {
    mode,
    agentUrl: environment.UMAMUSUME_AGENT_URL?.trim() || environment.VITE_UMAMUSUME_AGENT_URL?.trim() || "http://127.0.0.1:1111",
    agentApiKey: environment.UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() || environment.VITE_UMAMUSUME_AGENT_API_ACCESS_KEY?.trim() || "",
  };
}
