import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5179,
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3102",
        configure: (proxy) => { proxy.on("error", () => {}) },
      },
      "/ws": {
        target: "ws://localhost:3102",
        ws: true,
        configure: (proxy) => { proxy.on("error", () => {}) },
      },
    },
  },
})
