import { describe, expect, it } from "vitest"
import { formatModChord, MOD, resolveKeyCaption, resolveKeyCaptions } from "./mod-hint"

describe("resolveKeyCaption", () => {
  it("maps Mod / legacy ⌘/Ctrl to the active OS caption", () => {
    expect(resolveKeyCaption(MOD, "⌘")).toBe("⌘")
    expect(resolveKeyCaption("⌘/Ctrl", "Ctrl")).toBe("Ctrl")
    expect(resolveKeyCaption(`${MOD}+K`, "⌘")).toBe("⌘+K")
    expect(resolveKeyCaption("⌘/Ctrl+K", "⌘")).toBe("⌘+K")
  })

  it("leaves other glyphs alone", () => {
    expect(resolveKeyCaption("↵", "⌘")).toBe("↵")
    expect(resolveKeyCaption("⇧", "Ctrl")).toBe("⇧")
  })

  it("resolves hint chords", () => {
    expect(resolveKeyCaptions([MOD, "\\"], "⌘")).toEqual(["⌘", "\\"])
    expect(resolveKeyCaptions(["⌘/Ctrl", "↵"], "Ctrl")).toEqual(["Ctrl", "↵"])
  })

  it("formats compact title chords", () => {
    expect(formatModChord("\\", "⌘")).toBe("⌘\\")
    expect(formatModChord("\\", "Ctrl")).toBe("Ctrl+\\")
    expect(formatModChord("F", "⌘")).toBe("⌘F")
    expect(formatModChord("F", "Ctrl")).toBe("Ctrl+F")
  })
})
