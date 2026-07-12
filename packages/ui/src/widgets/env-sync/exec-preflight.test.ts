import { describe, expect, it } from "vitest"

import type { SyncPlan } from "../../types"
import { buildExecPreflightChecks, execPreflightBlocked } from "./exec-preflight"

function minimalPlan(overrides?: Partial<SyncPlan["preflight"]>): SyncPlan {
  return {
    planId: "p1",
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    entity: { type: "contract", id: 1, displayName: "Test" },
    source: "UAT",
    target: "DEV",
    preflight: {
      catalogCompatible: true,
      issues: [],
      rootParentReady: true,
      rootParentIssue: null,
      ...overrides
    },
    tables: [],
    totals: {
      insert: 1,
      update: 0,
      delete: 0,
      unchanged: 0,
      lowConfidence: 0,
      conflicts: 0,
      tablesCount: 1
    },
    dependencyGraph: { nodes: [], edges: [] },
    warnings: [],
    estimatedDurationSec: 1,
    executionContract: {} as SyncPlan["executionContract"]
  }
}

describe("execPreflight", () => {
  it("blocks when catalog drift was detected at preview", () => {
    const plan = minimalPlan({ catalogCompatible: false, issues: ["core.Contract.foo: missing on target"] })
    expect(execPreflightBlocked(plan)).toBe(true)
    expect(buildExecPreflightChecks(plan).find((c) => c.id === "catalog")?.passed).toBe(false)
  })

  it("passes when all blocking checks are green", () => {
    expect(execPreflightBlocked(minimalPlan())).toBe(false)
  })

  it("does not block when metadata is already in sync (zero row changes)", () => {
    const plan = minimalPlan()
    plan.totals = {
      insert: 0,
      update: 0,
      delete: 0,
      unchanged: 42,
      lowConfidence: 0,
      conflicts: 0,
      tablesCount: 0
    }
    expect(execPreflightBlocked(plan)).toBe(false)
    const meta = buildExecPreflightChecks(plan).find((c) => c.id === "metadata-diff")
    expect(meta?.blocking).toBe(false)
    expect(meta?.passed).toBe(true)
    expect(meta?.detail).toContain("no-op")
  })
})
