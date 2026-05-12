import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// term UI runs on its own port so both shells can be served side-by-side
// during dev. Production builds plug into the same server static dir.
const BASE_PATH = process.env["VITE_BASE_PATH"] ?? "/"

export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
  resolve: {
    extensions: [".mjs", ".mts", ".ts", ".tsx", ".jsx", ".js", ".json"],
  },
  server: {
    port: 5180,
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
})
