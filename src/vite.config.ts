import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The renderer is consumed by the Electron shell: dev loads http://localhost:5173,
// prod loads the built static bundle from src/dist. We expose a stable base path
// so the built index.html references /assets/... (relative) instead of absolute.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@cookietodo/renderer": resolve(__dirname, "src"),
    },
  },
});
