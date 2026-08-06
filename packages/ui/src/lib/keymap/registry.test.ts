import { describe, expect, it } from "vitest"
import { filterShortcutRegistry, SHORTCUT_REGISTRY } from "./registry"

describe("keymap registry", () => {
  it("filters by query across both columns", () => {
    const hit = filterShortcutRegistry(SHORTCUT_REGISTRY, "summon")
    expect(hit.some((item) => item.id === "summon")).toBe(true)
  })

  it("keeps both pane and shell chords on one board", () => {
    const all = filterShortcutRegistry(SHORTCUT_REGISTRY, "")
    expect(all.some((item) => item.category === "pane")).toBe(true)
    expect(all.some((item) => item.category === "workspace" || item.category === "global")).toBe(
      true,
    )
  })

  it("hides the other pane’s exclusive chords for Active Context", () => {
    const detail = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "detail")
    expect(detail.some((item) => item.id === "review-tree-move")).toBe(false)
    expect(detail.some((item) => item.id === "review-detail-move")).toBe(true)

    const tree = filterShortcutRegistry(SHORTCUT_REGISTRY, "", "tree")
    expect(tree.some((item) => item.id === "review-detail-move")).toBe(false)
    expect(tree.some((item) => item.id === "review-tree-move")).toBe(true)
  })
})
