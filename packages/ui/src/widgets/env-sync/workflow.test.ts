import { describe, expect, it } from "vitest"
import type { SyncPlan } from "../../types"
import { isPreviewEntityReady, planMatchesSelection, previewEntityRef, type SyncSelection } from "./workflow"

const baseSelection: SyncSelection = {
  source: "uat",
  target: "dev",
  entityType: "contract",
  committedEntityId: "100",
  force: false,
  searchMode: "id",
  enabledOptionalTables: [],
}

function planFor(entityId: number): SyncPlan {
  return {
    planId: "p1",
    source: "uat",
    target: "dev",
    entity: { type: "contract", id: entityId, displayName: null },
    executionContract: { definitionId: "contract" },
  } as SyncPlan
}

describe("env-sync workflow", () => {
  it("previewEntityRef prefers committed id over search draft", () => {
    expect(previewEntityRef("42", "draft")).toBe("42")
    expect(previewEntityRef("", "draft")).toBe("draft")
  })

  it("planMatchesSelection requires committed entity id", () => {
    const plan = planFor(100)
    expect(planMatchesSelection(plan, baseSelection)).toBe(true)
    expect(planMatchesSelection(plan, { ...baseSelection, committedEntityId: "" })).toBe(false)
    expect(planMatchesSelection(plan, { ...baseSelection, committedEntityId: "200" })).toBe(false)
  })

  it("isPreviewEntityReady blocks during search and requires pick in name mode", () => {
    expect(isPreviewEntityReady(baseSelection, "", { searchLoading: false })).toBe(true)
    expect(isPreviewEntityReady(baseSelection, "draft", { searchLoading: true })).toBe(false)
    expect(isPreviewEntityReady({ ...baseSelection, committedEntityId: "", searchMode: "name" }, "partial", { searchLoading: false })).toBe(false)
    expect(isPreviewEntityReady({ ...baseSelection, committedEntityId: "", searchMode: "id" }, "42", { searchLoading: false })).toBe(true)
    expect(isPreviewEntityReady({ ...baseSelection, committedEntityId: "", searchMode: "id" }, "abc", { searchLoading: false })).toBe(false)
  })
})
