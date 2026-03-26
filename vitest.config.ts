import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@agent001": new URL("./src", import.meta.url).pathname,
    },
  },
})
