import { describe, expect, it } from "vitest"
import { buildChangeSet } from "../../../domain/diff-engine/change-set.js"
import type { SyncPlan, SyncPlanTable } from "../plan-store.js"
import { constraintRelaxationTables, dataMovementTables } from "./metadata-scope.js"
import { hasChangeSetWork, upsertRows, validatePlan } from "./plan-table.js"

describe("plan-table changeSet", () => {
  it("buildChangeSet copies PK values from diff rows", () => {
    const cs = buildChangeSet(
      [{ pk: "1", rowHash: "a", pkValues: { pipelineId: 1 } }],
      [],
      [{ pk: "9", rowHash: "b", pkValues: { pipelineId: 9 } }]
    )
    expect(cs.insert).toEqual([{ pk: "1", values: { pipelineId: 1 } }])
    expect(cs.delete).toEqual([{ pk: "9", values: { pipelineId: 9 } }])
  })

  it("validatePlan rejects tables without changeSet", () => {
    const plan = {
      tables: [{ table: "core.Pipeline", stats: { unchanged: 0, lowConfidence: 0 } }]
    } as SyncPlan
    expect(() => validatePlan(plan)).toThrow(/missing changeSet/)
  })

  it("validatePlan rejects totals that disagree with changeSet-derived counts", () => {
    const table: SyncPlanTable = {
      table: "core.Pipeline",
      scopePredicate: "x",
      stats: { unchanged: 0, lowConfidence: 0 },
      changeSet: {
        insert: [{ pk: "1", values: { id: 1 } }],
        update: [],
        delete: []
      },
      samples: { insert: [], update: [], delete: [] },
      conflicts: [],
      warnings: [],
      diffDurationMs: 0
    }
    expect(() =>
      validatePlan({
        tables: [table],
        totals: { insert: 2, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 1 }
      } as SyncPlan)
    ).toThrow(/totals\.insert/)
  })

  it("invariant: one pipeline insert → one data movement table only", () => {
    const order = ["core.Contract", "core.ContractColumn", "core.Dataset", "core.Pipeline"]
    const plan = {
      executionContract: {
        metadata: { executionOrder: order, reverseOrder: [...order].reverse(), tables: [] }
      },
      tables: order.map((table) => ({
        table,
        scopePredicate: "contractId = 1",
        stats: { unchanged: 10, lowConfidence: 0 },
        changeSet: {
          insert:
            table === "core.Pipeline" ? [{ pk: "99", values: { pipelineId: 99, contractId: 1 } }] : [],
          update: [],
          delete: []
        },
        samples: { insert: [], update: [], delete: [] },
        conflicts: [],
        warnings: [],
        diffDurationMs: 0
      })),
      totals: { insert: 1, update: 0, delete: 0, unchanged: 40, lowConfidence: 0, conflicts: 0, tablesCount: 1 }
    } as unknown as SyncPlan

    validatePlan(plan)
    expect([...dataMovementTables(plan)]).toEqual(["core.Pipeline"])
    expect(constraintRelaxationTables(plan).has("core.ContractColumn")).toBe(true)
    expect(dataMovementTables(plan).has("core.Contract")).toBe(false)
    expect(upsertRows(plan.tables.find((t) => t.table === "core.Pipeline")!)).toHaveLength(1)
    expect(hasChangeSetWork(plan.tables.find((t) => t.table === "core.Contract")!)).toBe(false)
  })
})
