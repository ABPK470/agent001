import { describe, expect, it } from "vitest"
import { resolveShellKeyboardAction } from "./resolve-shell-keyboard"

function key(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  }
}

describe("resolveShellKeyboardAction", () => {
  it("calls spaces 1–5 with mod", () => {
    expect(
      resolveShellKeyboardAction(key({ key: "2", metaKey: true }), { hasFocusedTile: false }),
    ).toEqual({ type: "call-space", index: 2 })
    expect(
      resolveShellKeyboardAction(key({ key: "5", metaKey: true }), { hasFocusedTile: false }),
    ).toEqual({ type: "call-space", index: 5 })
  })

  it("toggles maximize with M when a tile is focused", () => {
    expect(
      resolveShellKeyboardAction(key({ key: "m" }), { hasFocusedTile: true }),
    ).toEqual({ type: "toggle-maximize" })
    expect(
      resolveShellKeyboardAction(key({ key: "m" }), { hasFocusedTile: false }),
    ).toEqual({ type: "none" })
  })

  it("opens keymap on ?", () => {
    expect(
      resolveShellKeyboardAction(key({ key: "?", shiftKey: true }), { hasFocusedTile: false }),
    ).toEqual({ type: "open-keymap" })
  })

  it("moves tile focus with mod+shift+arrow (not mod+alt — shell toggle owns that)", () => {
    expect(
      resolveShellKeyboardAction(
        key({ key: "ArrowRight", metaKey: true, shiftKey: true }),
        { hasFocusedTile: true },
      ),
    ).toEqual({ type: "focus-tile-neighbor", key: "ArrowRight" })
    expect(
      resolveShellKeyboardAction(
        key({ key: "ArrowRight", metaKey: true, altKey: true }),
        { hasFocusedTile: true },
      ),
    ).toEqual({ type: "none" })
  })

  it("mod+shift+arrow still moves tile focus while typing in an editable field", () => {
    expect(
      resolveShellKeyboardAction(
        key({ key: "ArrowLeft", metaKey: true, shiftKey: true }),
        { hasFocusedTile: true, editable: true },
      ),
    ).toEqual({ type: "focus-tile-neighbor", key: "ArrowLeft" })
    expect(
      resolveShellKeyboardAction(key({ key: "m" }), {
        hasFocusedTile: true,
        editable: true,
      }),
    ).toEqual({ type: "none" })
  })

  it("cycles toolbar views with mod+[ / ]", () => {
    expect(
      resolveShellKeyboardAction(key({ key: "]", metaKey: true }), { hasFocusedTile: false }),
    ).toEqual({ type: "cycle-view", direction: 1 })
    expect(
      resolveShellKeyboardAction(key({ key: "[", ctrlKey: true }), { hasFocusedTile: true }),
    ).toEqual({ type: "cycle-view", direction: -1 })
  })
})
