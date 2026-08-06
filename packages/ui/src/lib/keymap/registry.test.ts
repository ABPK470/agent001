import { describe, expect, it } from "vitest"
import {
  filterShortcutRegistry,
  keymapTabFromDigit,
  nextKeymapTab,
  SHORTCUT_REGISTRY,
} from "./registry"

describe("keymap registry", () => {
  it("filters by tab and query", () => {
    const pane = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "pane")
    expect(pane.every((item) => item.category === "pane")).toBe(true)
    expect(pane.length).toBeGreaterThan(0)

    const shell = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "shell")
    expect(shell.every((item) => item.category !== "pane")).toBe(true)

    const hit = filterShortcutRegistry(SHORTCUT_REGISTRY, "summon", "all")
    expect(hit.some((item) => item.id === "summon")).toBe(true)
  })

  it("hides the other pane’s exclusive chords for Active Context", () => {
    const detail = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "pane", "detail")
    expect(detail.some((item) => item.id === "review-tree-move")).toBe(false)
    expect(detail.some((item) => item.id === "review-detail-section")).toBe(true)

    const tree = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "pane", "tree")
    expect(tree.some((item) => item.id === "review-detail-section")).toBe(false)
    expect(tree.some((item) => item.id === "review-tree-move")).toBe(true)
  })

  it("cycles tabs and maps digits", () => {
    expect(nextKeymapTab("all", 1)).toBe("pane")
    expect(nextKeymapTab("shell", 1)).toBe("all")
    expect(nextKeymapTab("all", -1)).toBe("shell")
    expect(keymapTabFromDigit("2")).toBe("pane")
    expect(keymapTabFromDigit("9")).toBeNull()
  })
})
