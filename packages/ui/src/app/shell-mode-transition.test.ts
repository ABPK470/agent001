import { describe, expect, it } from "vitest"
import {
  SHELL_MODE_TO_CHAT_MS,
  SHELL_MODE_TO_WORKSPACE_MS,
} from "./shell-mode-transition"
import { shellStagePhase } from "./ShellModeStage"

describe("shell mode transition", () => {
  it("keeps reverse faster than forward", () => {
    expect(SHELL_MODE_TO_WORKSPACE_MS).toBe(240)
    expect(SHELL_MODE_TO_CHAT_MS).toBe(180)
    expect(SHELL_MODE_TO_CHAT_MS).toBeLessThan(SHELL_MODE_TO_WORKSPACE_MS)
  })

  it("maps mode + transition to a stage phase", () => {
    expect(shellStagePhase("chat", null)).toBe("chat")
    expect(shellStagePhase("workspace", null)).toBe("workspace")
    expect(shellStagePhase("chat", { to: "workspace" })).toBe("to-workspace")
    expect(shellStagePhase("workspace", { to: "chat" })).toBe("to-chat")
  })
})
