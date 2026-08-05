import { describe, expect, it } from "vitest"
import { resolveTreeKeyboardAction } from "./trace-tree-keyboard"

describe("trace-tree-keyboard", () => {
  it("re-exports shared keyboard resolver with flatIndex on nodes", () => {
    const nodes = [
      { scopeId: "a", parentScopeId: null, hasChildren: false, flatIndex: 0 },
      { scopeId: "b", parentScopeId: null, hasChildren: false, flatIndex: 1 },
    ]
    expect(resolveTreeKeyboardAction("ArrowDown", nodes, "a", () => false)).toEqual({
      type: "select",
      scopeId: "b",
      flatIndex: 1,
    })
  })
})
