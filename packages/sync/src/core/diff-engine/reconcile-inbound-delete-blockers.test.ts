import { describe, expect, it } from "vitest"
import { reconcileInboundDeleteBlockers } from "./reconcile-inbound-delete-blockers.js"
import type { SyncPlanTable } from "../../domain/plan.js"

function table(
  name: string,
  deletes: Array<{ pk: string; values: Record<string, unknown> }>,
  conflicts: SyncPlanTable["conflicts"] = []
): SyncPlanTable {
  return {
    table: name,
    scopePredicate: "datasetId = 1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: { insert: [], update: [], delete: deletes },
    samples: { insert: [], update: [], delete: [] },
    conflicts,
    warnings: [],
    diffDurationMs: 0
  }
}

describe("reconcileInboundDeleteBlockers", () => {
  it("leaves tables unchanged when there are no hits", () => {
    const tables = [table("core.DatasetColumn", [{ pk: "10", values: { datasetColumnId: 10 } }])]
    expect(reconcileInboundDeleteBlockers(tables, [])).toEqual(tables)
  })

  it("promotes out-of-scope inbound refs to conflicts and demotes those deletes", () => {
    const tables = [
      table("core.DatasetColumn", [
        { pk: "10", values: { datasetColumnId: 10 } },
        { pk: "11", values: { datasetColumnId: 11 } }
      ]),
      table("core.DatasetMappingColumn", [])
    ]

    const next = reconcileInboundDeleteBlockers(tables, [
      {
        deletedTable: "core.DatasetColumn",
        deletedPk: "10",
        referencingTable: "core.DatasetMappingColumn",
        referencingColumn: "datasetColumnId_right",
        referencingPk: "99",
        constraintName: "fk_datasetColumnId_right"
      }
    ])

    const datasetColumn = next.find((t) => t.table === "core.DatasetColumn")!
    expect(datasetColumn.changeSet.delete.map((r) => r.pk)).toEqual(["11"])
    expect(datasetColumn.conflicts).toHaveLength(1)
    expect(datasetColumn.conflicts[0]?.kind).toBe("inbound_reference")
    expect(datasetColumn.conflicts[0]?.actualScope).toMatchObject({
      referencingTable: "core.DatasetMappingColumn",
      referencingColumn: "datasetColumnId_right",
      referencingPk: "99",
      constraintName: "fk_datasetColumnId_right"
    })
    expect(datasetColumn.warnings[0]).toContain("inbound references")
  })

  it("ignores inbound hits whose referencing row is already in this plan's deletes", () => {
    const tables = [
      table("core.DatasetColumn", [{ pk: "10", values: { datasetColumnId: 10 } }]),
      table("core.DatasetMappingColumn", [{ pk: "99", values: { datasetMappingColumnId: 99 } }])
    ]

    const next = reconcileInboundDeleteBlockers(tables, [
      {
        deletedTable: "core.DatasetColumn",
        deletedPk: "10",
        referencingTable: "core.DatasetMappingColumn",
        referencingColumn: "datasetColumnId_right",
        referencingPk: "99",
        constraintName: "fk_datasetColumnId_right"
      }
    ])

    const datasetColumn = next.find((t) => t.table === "core.DatasetColumn")!
    expect(datasetColumn.changeSet.delete.map((r) => r.pk)).toEqual(["10"])
    expect(datasetColumn.conflicts).toEqual([])
  })
})
