import { describe, expect, it } from "vitest"
import {
  shellModeTransitionMs,
  shellTrackSlideClass,
  SHELL_WIPE_MS,
} from "./shell-mode-wipe"

describe("shell mode spatial track", () => {
  it("slides over 220ms", () => {
    expect(SHELL_WIPE_MS).toBe(220)
    expect(shellModeTransitionMs("chat")).toBe(220)
  })

  it("places workspace at 0 and chat at -50%", () => {
    expect(shellTrackSlideClass("workspace")).toBe("app-shell-slider--workspace")
    expect(shellTrackSlideClass("chat")).toBe("app-shell-slider--chat")
  })
})
