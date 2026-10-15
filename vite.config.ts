import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/functions/v1/app": "http://127.0.0.1:8000",
  // changeOrigin keeps Host = 127.0.0.1:8000, which the local router requires.
  "/local": { target: "http://127.0.0.1:8000", changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
  build: { outDir: "dist" },
});
