import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";
import { resolveStageConfig } from "./src/stage-config";

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("../../", import.meta.url));
  const stageConfig = resolveStageConfig({ ...loadEnv(mode, envDir, ""), ...process.env }, mode === "production");
  return {
    base: mode === "production" ? "/umamusume-agent-stage/" : "/",
    envDir,
    // Only the allowlisted config reaches the browser; never expose the entire .env.
    envPrefix: [],
    define: { __STAGE_CONFIG__: JSON.stringify(stageConfig) },
    plugins: [vue()],
    publicDir: fileURLToPath(new URL("../../content", import.meta.url)),
    server: {
      host: "127.0.0.1",
      port: 4173,
    },
    preview: {
      host: "127.0.0.1",
      port: 4174,
    },
    build: {
      // Phaser is a self-contained engine chunk; the Vue shell loads separately.
      chunkSizeWarningLimit: 1600,
    },
  };
});
