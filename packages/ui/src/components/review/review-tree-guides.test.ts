import { describe, expect, it } from "vitest"
import { buildGuideSlots, shouldDrawGuideLine } from "./review-tree-guides"

describe("buildGuideSlots", () => {
  it("marks sibling Preview branch and Execute corner under a pipeline", () => {
    const nodes = [
      { depth: 0, parentScopeId: null },
      { depth: 1, parentScopeId: "run" },
      { depth: 1, parentScopeId: "run" },
    ]
    expect(buildGuideSlots(nodes, 0)).toEqual([])
    expect(buildGuideSlots(nodes, 1)).toEqual(["branch"])
    expect(buildGuideSlots(nodes, 2)).toEqual(["corner"])
  })

  it("draws a continuing line when a later sibling at that level follows", () => {
    const nodes = [
      { depth: 0, parentScopeId: null },
      { depth: 1, parentScopeId: "run" },
      { depth: 2, parentScopeId: "preview" },
      { depth: 1, parentScopeId: "run" },
    ]
    expect(buildGuideSlots(nodes, 2)).toEqual(["line", "corner"])
  })

  it("does not paint a phantom stem under a └ parent (Execute → Completed)", () => {
    const nodes = [
      { depth: 0, parentScopeId: null },
      { depth: 1, parentScopeId: "run" }, // Preview
      { depth: 1, parentScopeId: "run" }, // Execute (last phase → corner)
      { depth: 2, parentScopeId: "execute" }, // Preflight
      { depth: 2, parentScopeId: "execute" }, // Started
      { depth: 2, parentScopeId: "execute" }, // MetadataSync
      { depth: 3, parentScopeId: "meta" }, // child
      { depth: 3, parentScopeId: "meta" }, // SyncDate (last under meta)
      { depth: 2, parentScopeId: "execute" }, // Completed (last under Execute)
      { depth: 0, parentScopeId: null }, // next pipeline
    ]
    // Children of Execute: no far-left line (Execute was already └).
    expect(buildGuideSlots(nodes, 3)).toEqual(["blank", "branch"])
    expect(buildGuideSlots(nodes, 5)).toEqual(["blank", "branch"])
    // Nest under MetadataSync: Execute-stem continues (Completed follows), meta ends └.
    expect(buildGuideSlots(nodes, 6)).toEqual(["blank", "line", "branch"])
    expect(buildGuideSlots(nodes, 7)).toEqual(["blank", "line", "corner"])
    // Completed closes Execute with └ — no orphan stem above.
    expect(buildGuideSlots(nodes, 8)).toEqual(["blank", "corner"])
  })

  it("shouldDrawGuideLine requires a later node at exactly level+1", () => {
    const nodes = [
      { depth: 2 },
      { depth: 3 }, // deeper only — not a sibling at level+1
      { depth: 0 },
    ]
    expect(shouldDrawGuideLine(nodes, 0, 0)).toBe(false)
    expect(shouldDrawGuideLine([{ depth: 2 }, { depth: 1 }], 0, 0)).toBe(true)
  })
})
