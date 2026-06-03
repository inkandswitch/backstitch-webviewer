import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/api": {
        target: "http://24.199.97.236:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/lorejam-api": {
        target: "http://lorejam.backstitch.dev:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lorejam-api/, ""),
      },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
