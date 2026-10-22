import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@shared": new URL("../server/src/shared.ts", import.meta.url).pathname } },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:7420", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
