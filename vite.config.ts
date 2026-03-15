import { defineConfig } from "vite";
import path from "path";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],
  resolve: {
    alias: {
      "@codemirror/state": path.resolve(__dirname, "node_modules/@codemirror/state"),
      "@codemirror/view": path.resolve(__dirname, "node_modules/@codemirror/view"),
      "@codemirror/language": path.resolve(__dirname, "node_modules/@codemirror/language"),
      "@lezer/highlight": path.resolve(__dirname, "node_modules/@lezer/highlight"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
