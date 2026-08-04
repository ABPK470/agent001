import { describe, expect, it } from "vitest"
import { SHELL_MODE_SWEEP_MS } from "./shell-mode-transition"

describe("shell mode sweep", () => {
  it("runs long enough to read the ASCII transform", () => {
    expect(SHELL_MODE_SWEEP_MS).toBeGreaterThanOrEqual(480)
    expect(SHELL_MODE_SWEEP_MS).toBeLessThanOrEqual(640)
  })
})
