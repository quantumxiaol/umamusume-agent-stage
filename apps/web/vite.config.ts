import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/umamusume-agent-stage/" : "/",
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  envPrefix: ["VITE_", "UMAMUSUME_"],
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
}));
