import { describe, expect, it } from "vitest"
import type { SyncPlan, SyncPlanTable } from "../plan-store.js"
import { constraintRelaxationTables, dataMovementTables } from "./metadata-scope.js"

function row(
  table: string,
  movement: { insert?: number; update?: number; delete?: number },
  changeSet?: SyncPlanTable["changeSet"]
): SyncPlanTable {
  const insert = movement.insert ?? 0
  const update = movement.update ?? 0
  const del = movement.delete ?? 0
  return {
    table,
    scopePredicate: "contractId = 1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: changeSet ?? {
      insert: Array.from({ length: insert }, (_, i) => ({ pk: `${table}:i${i}`, values: { id: i } })),
      update: Array.from({ length: update }, (_, i) => ({ pk: `${table}:u${i}`, values: { id: i } })),
      delete: Array.from({ length: del }, (_, i) => ({ pk: `${table}:d${i}`, values: { id: i } }))
    },
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 0
  }
}

function planWithTables(tables: SyncPlanTable[]): SyncPlan {
  const order = tables.map((t) => t.table)
  return {
    executionContract: {
      metadata: {
        executionOrder: order,
        reverseOrder: [...order].reverse(),
        tables: order.map((name) => ({ name, scopeColumn: "contractId", predicate: "contractId = 1" }))
      }
    },
    tables
  } as unknown as SyncPlan
}

describe("metadata scope from changeSet", () => {
  it("dataMovementTables lists only tables with changeSet insert/update PKs", () => {
    const plan = planWithTables([
      row("core.Contract", {}),
      row("core.ContractColumn", { insert: 2 }),
      row("core.Dataset", {})
    ])
    const movement = dataMovementTables(plan)
    expect(movement.has("core.Contract")).toBe(false)
    expect(movement.has("core.ContractColumn")).toBe(true)
    expect(movement.has("core.Dataset")).toBe(false)
  })

  it("pipeline-only insert touches only core.Pipeline in data movement", () => {
    const order = ["core.Contract", "core.ContractColumn", "core.Dataset", "core.Pipeline"]
    const plan = planWithTables([
      row("core.Contract", {}),
      row("core.ContractColumn", {}),
      row("core.Dataset", {}),
      row("core.Pipeline", { insert: 1 })
    ])
    const movement = dataMovementTables(plan)
    expect([...movement]).toEqual(["core.Pipeline"])
    const relax = constraintRelaxationTables(plan)
    expect(relax.has("core.Contract")).toBe(true)
    expect(relax.has("core.Pipeline")).toBe(true)
    expect(relax.has("core.Dataset")).toBe(true)
  })

  it("constraintRelaxationTables includes ancestors through deepest changeSet op", () => {
    const plan = planWithTables([
      row("core.Contract", {}),
      row("core.ContractColumn", {}),
      row("core.Dataset", { delete: 1 })
    ])
    const relax = constraintRelaxationTables(plan)
    expect(relax.has("core.Contract")).toBe(true)
    expect(relax.has("core.ContractColumn")).toBe(true)
    expect(relax.has("core.Dataset")).toBe(true)
  })
})
