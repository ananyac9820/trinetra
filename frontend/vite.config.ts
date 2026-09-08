import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is same-origin in deployment, so the dev server proxies rather
    // than the client carrying a base URL that has to change per environment.
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // MapLibre and deck.gl are large. Splitting them keeps the landing page,
    // which must load in under two seconds, from paying for the Explorer's
    // WebGL stack before anyone opens the Explorer.
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"],
          deck: ["@deck.gl/core", "@deck.gl/layers", "@deck.gl/mapbox"],
          charts: ["uplot"],
        },
      },
    },
  },
});
