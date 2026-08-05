import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// VITE_BASE_PATH lets us mount the SPA under a sub-path (e.g. "/agent001/")
// when deploying behind a corporate reverse proxy that routes the URL prefix
// to this server. Default is "/" so dev and standalone deploys are unchanged.
const BASE_PATH = process.env["VITE_BASE_PATH"] ?? "/"

/** Repo root — so root `.env` VITE_* flags (e.g. local harness) load in DEV. */
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")

export default defineConfig({
  base: BASE_PATH,
  envDir: repoRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: ['.mjs', '.mts', '.ts', '.tsx', '.jsx', '.js', '.json'],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { '.js': 'jsx' },
    },
  },
  server: {
    port: 5179,
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3102",
        configure: (proxy) => { proxy.on("error", () => {}) },
      },
      "/ws": {
        target: "ws://127.0.0.1:3102",
        ws: true,
        configure: (proxy) => { proxy.on("error", () => {}) },
      },
    },
  },
  build: {
    // Never ship source maps — dev-only, large, and break some Windows copy tools.
    sourcemap: false,
  },
})
