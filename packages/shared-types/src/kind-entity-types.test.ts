import { describe, expect, it } from "vitest"
import {
  kindAllowsEntityType,
  normalizeSyncFlowKindEntityTypes,
} from "./kind-entity-types.js"

describe("normalizeSyncFlowKindEntityTypes", () => {
  it("defaults empty to any", () => {
    expect(normalizeSyncFlowKindEntityTypes([])).toEqual(["any"])
  })

  it("keeps any alone", () => {
    expect(normalizeSyncFlowKindEntityTypes(["any"])).toEqual(["any"])
  })

  it("drops any when a scoped type is selected last", () => {
    expect(normalizeSyncFlowKindEntityTypes(["any", "content"])).toEqual(["content"])
  })

  it("collapses to any when any is selected last", () => {
    expect(normalizeSyncFlowKindEntityTypes(["content", "contract", "any"])).toEqual(["any"])
  })

  it("dedupes scoped types", () => {
    expect(normalizeSyncFlowKindEntityTypes(["content", "content", "rule"])).toEqual([
      "content",
      "rule",
    ])
  })
})

describe("kindAllowsEntityType", () => {
  it("treats missing as any", () => {
    expect(kindAllowsEntityType(undefined, "content")).toBe(true)
  })

  it("respects scoped lists", () => {
    expect(kindAllowsEntityType(["contract"], "content")).toBe(false)
    expect(kindAllowsEntityType(["contract"], "contract")).toBe(true)
  })
})
