import { describe, expect, it } from "vitest"
import { buildSyncPreviewDashboard, formatSyncPreviewDashboardFence } from "./preview-dashboard.js"
import type { SyncPlan } from "./plan-store.js"

function minimalPlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    planId: "plan-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdAtMs: 0,
    entity: { type: "contract", id: 1, displayName: "ACSRawTest" },
    source: "uat",
    target: "dev",
    preflight: { catalogCompatible: true, issues: [] },
    tables: [],
    totals: {
      insert: 102,
      update: 0,
      delete: 0,
      unchanged: 0,
      lowConfidence: 0,
      conflicts: 0,
      tablesCount: 8
    },
    dependencyGraph: {
      nodes: [{ id: "core.Contract", label: "Contract", status: "insert", counts: { insert: 1, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 } }],
      edges: []
    },
    warnings: [],
    estimatedDurationSec: 12,
    recipeSnapshot: { entityType: "contract", tables: [], executionOrder: [], reverseOrder: [] },
    ...overrides
  }
}

describe("buildSyncPreviewDashboard", () => {
  it("emits kpi row and relationships items", () => {
    const dash = buildSyncPreviewDashboard(minimalPlan())
    expect(dash.items.length).toBeGreaterThanOrEqual(2)
    expect(dash.items[0]?.kind).toBe("kpi")
    expect((dash.items[0]?.spec as { cards: unknown[] }).cards).toHaveLength(5)
    expect(dash.items.some((i) => i.kind === "relationships")).toBe(true)
  })

  it("formats a dashboard fenced block for tool output", () => {
    const fence = formatSyncPreviewDashboardFence(minimalPlan())
    expect(fence.startsWith("```dashboard\n")).toBe(true)
    expect(fence.endsWith("```")).toBe(true)
    const json = fence.slice("```dashboard\n".length, -3)
    const parsed = JSON.parse(json) as { items: unknown[] }
    expect(parsed.items.length).toBeGreaterThan(0)
  })
})
