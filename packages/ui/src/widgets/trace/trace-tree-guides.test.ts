import { describe, expect, it } from "vitest"
import { buildGuideSlots } from "./trace-tree-guides"

describe("buildGuideSlots", () => {
  it("marks sibling Prompt branch and Plan corner under Context", () => {
    const nodes = [
      { depth: 0, parentScopeId: null },
      { depth: 1, parentScopeId: "context" },
      { depth: 1, parentScopeId: "context" },
    ]
    expect(buildGuideSlots(nodes, 0)).toEqual([])
    expect(buildGuideSlots(nodes, 1)).toEqual(["branch"])
    expect(buildGuideSlots(nodes, 2)).toEqual(["corner"])
  })

  it("draws a continuing line when deeper siblings follow", () => {
    const nodes = [
      { depth: 0, parentScopeId: null },
      { depth: 1, parentScopeId: "context" },
      { depth: 2, parentScopeId: "prompt" },
      { depth: 1, parentScopeId: "context" },
    ]
    expect(buildGuideSlots(nodes, 2)).toEqual(["line", "corner"])
  })
})
