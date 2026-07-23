import { describe, expect, it } from "vitest"
import { isShellModeToggleEvent, shellModeToggleHint } from "./types"

describe("shell mode toggle shortcut", () => {
  it("matches mod+backslash only", () => {
    expect(
      isShellModeToggleEvent({
        code: "Backslash",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(true)
    expect(
      isShellModeToggleEvent({
        code: "Backslash",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(true)
    expect(
      isShellModeToggleEvent({
        code: "Backslash",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      } as KeyboardEvent),
    ).toBe(false)
    expect(
      isShellModeToggleEvent({
        code: "KeyC",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(false)
  })

  it("formats a short hint", () => {
    expect(shellModeToggleHint("⌘")).toBe("⌘\\")
    expect(shellModeToggleHint("Ctrl")).toBe("Ctrl\\")
  })
})
