import { describe, expect, it } from "vitest"
import { isShellModeToggleEvent, shellModeToggleHint } from "./types"

describe("shell mode toggle shortcut", () => {
  it("matches mod+option/alt only", () => {
    expect(
      isShellModeToggleEvent({
        code: "AltLeft",
        key: "Alt",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(true)
    expect(
      isShellModeToggleEvent({
        code: "AltRight",
        key: "Alt",
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(true)
    expect(
      isShellModeToggleEvent({
        code: "AltLeft",
        key: "Alt",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: true,
      } as KeyboardEvent),
    ).toBe(false)
    expect(
      isShellModeToggleEvent({
        code: "Backslash",
        key: "\\",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(false)
    expect(
      isShellModeToggleEvent({
        code: "KeyC",
        key: "c",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      } as KeyboardEvent),
    ).toBe(false)
  })

  it("formats a short hint", () => {
    expect(shellModeToggleHint("⌘")).toBe("⌘⌥")
    expect(shellModeToggleHint("Ctrl")).toBe("Ctrl+Alt")
  })
})
