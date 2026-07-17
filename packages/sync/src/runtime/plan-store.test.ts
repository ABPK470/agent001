import { afterEach, describe, expect, it } from "vitest"

import {
  allocPlanId,
  configurePlanStore,
  deletePlan,
  loadPlan,
  planTooOldToExecute,
  savePlan
} from "./plan-store.js"
import { buildEntityPlan } from "../test-support/plan-fixtures.js"
import { ENTITY_SPECS } from "../test-support/entity-fixtures.js"
import { createSyncTestProject, drainTempSyncProjects } from "../test-support/sync-test-host.js"

afterEach(() => {
  drainTempSyncProjects()
})

describe("plan-store", () => {
  it("allocates unique plan ids", () => {
    const a = allocPlanId()
    const b = allocPlanId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it("round-trips plans through memory and disk", () => {
    const { host } = createSyncTestProject(["contract"])
    const plan = buildEntityPlan({
      planId: "plan-roundtrip",
      entityType: "contract",
      entityId: 1,
      spec: ENTITY_SPECS.contract
    })
    savePlan(host, plan)
    expect(loadPlan(host, "plan-roundtrip")).toEqual(plan)
    host.sync.plans.memCache.delete("plan-roundtrip")
    expect(loadPlan(host, "plan-roundtrip")).toEqual(plan)
  })

  it("deletePlan removes memory and disk copies", () => {
    const { host } = createSyncTestProject(["contract"])
    const plan = buildEntityPlan({
      planId: "plan-delete",
      entityType: "contract",
      entityId: 2,
      spec: ENTITY_SPECS.contract
    })
    savePlan(host, plan)
    deletePlan(host, "plan-delete")
    expect(loadPlan(host, "plan-delete")).toBeNull()
  })

  it("planTooOldToExecute enforces 1h execute cap", () => {
    const fresh = buildEntityPlan({
      entityType: "contract",
      entityId: 3,
      spec: ENTITY_SPECS.contract,
      createdAtMs: Date.now()
    })
    const stale = buildEntityPlan({
      entityType: "contract",
      entityId: 3,
      spec: ENTITY_SPECS.contract,
      createdAtMs: Date.now() - 61 * 60 * 1000
    })
    expect(planTooOldToExecute(fresh)).toBe(false)
    expect(planTooOldToExecute(stale)).toBe(true)
  })

  it("rejects plans with invalid totals at save time", () => {
    const { host } = createSyncTestProject(["contract"])
    const plan = buildEntityPlan({
      planId: "plan-bad-totals",
      entityType: "contract",
      entityId: 4,
      spec: ENTITY_SPECS.contract,
      tables: [
        {
          table: "core.Pipeline",
          scopePredicate: "contractId = 4",
          stats: { unchanged: 0, lowConfidence: 0 },
          changeSet: { insert: [{ pk: "1", values: { pipelineId: 1 } }], update: [], delete: [] },
          samples: { insert: [], update: [], delete: [] },
          conflicts: [],
          warnings: [],
          diffDurationMs: 1
        }
      ]
    })
    plan.totals.insert = 0
    expect(() => savePlan(host, plan)).toThrow(/totals\.insert/)
  })

  it("loads from durable sink when memory and disk miss", () => {
    const { host } = createSyncTestProject(["contract"])
    const plan = buildEntityPlan({
      planId: "plan-sink",
      entityType: "contract",
      entityId: 5,
      spec: ENTITY_SPECS.contract
    })
    host.sync.runs.sink.loadPlan = () => plan
    expect(loadPlan(host, "plan-sink")).toEqual(plan)
  })

  it("configurePlanStore creates disk directory", () => {
    const { host, root } = createSyncTestProject(["contract"])
    const plansDir = `${root}/custom-plans`
    configurePlanStore(host, plansDir)
    expect(host.sync.plans.diskRoot).toBe(plansDir)
  })
})
