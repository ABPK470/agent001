import { describe, expect, it } from "vitest"
import { reconcilePlanConflicts } from "./plan-conflicts.js"
import type { SyncPlanTable } from "../../domain/plan.js"

function table(
  name: string,
  opts: {
    deletes?: Array<{ pk: string; values: Record<string, unknown> }>
    inserts?: Array<{ pk: string; values: Record<string, unknown> }>
  } = {}
): SyncPlanTable {
  return {
    table: name,
    scopePredicate: "datasetId = 1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: {
      insert: opts.inserts ?? [],
      update: [],
      delete: opts.deletes ?? []
    },
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 0
  }
}

describe("reconcilePlanConflicts", () => {
  it("leaves tables unchanged when there are no hits", () => {
    const tables = [table("core.DatasetColumn", { deletes: [{ pk: "10", values: { datasetColumnId: 10 } }] })]
    expect(reconcilePlanConflicts(tables, [])).toEqual(tables)
  })

  it("promotes inbound refs to conflicts with owner keys and demotes deletes", () => {
    const tables = [
      table("core.DatasetColumn", {
        deletes: [
          { pk: "10", values: { datasetColumnId: 10 } },
          { pk: "11", values: { datasetColumnId: 11 } }
        ]
      }),
      table("core.DatasetMappingColumn")
    ]

    const next = reconcilePlanConflicts(tables, [
      {
        kind: "inbound_reference",
        table: "core.DatasetColumn",
        pk: "10",
        referencingTable: "core.DatasetMappingColumn",
        referencingColumn: "datasetColumnId_right",
        referencingPk: "99",
        constraintName: "fk_datasetColumnId_right",
        owners: { datasetMappingId: 7, datasetId_Left: 42 }
      }
    ])

    const datasetColumn = next.find((t) => t.table === "core.DatasetColumn")!
    expect(datasetColumn.changeSet.delete.map((r) => r.pk)).toEqual(["11"])
    expect(datasetColumn.conflicts).toHaveLength(1)
    expect(datasetColumn.conflicts[0]?.kind).toBe("inbound_reference")
    expect(datasetColumn.conflicts[0]?.actualScope).toMatchObject({
      owners: { datasetMappingId: 7, datasetId_Left: 42 }
    })
    expect(datasetColumn.conflicts[0]?.summary).toContain("datasetId_Left=42")
  })

  it("ignores inbound hits already covered by sibling deletes", () => {
    const tables = [
      table("core.DatasetColumn", { deletes: [{ pk: "10", values: { datasetColumnId: 10 } }] }),
      table("core.DatasetMappingColumn", {
        deletes: [{ pk: "99", values: { datasetMappingColumnId: 99 } }]
      })
    ]

    const next = reconcilePlanConflicts(tables, [
      {
        kind: "inbound_reference",
        table: "core.DatasetColumn",
        pk: "10",
        referencingTable: "core.DatasetMappingColumn",
        referencingColumn: "datasetColumnId_right",
        referencingPk: "99",
        constraintName: "fk_datasetColumnId_right"
      }
    ])

    expect(next.find((t) => t.table === "core.DatasetColumn")!.conflicts).toEqual([])
  })

  it("promotes missing parents to conflicts and demotes inserts", () => {
    const tables = [
      table("core.DatasetMappingColumn", {
        inserts: [{ pk: "1", values: { datasetMappingColumnId: 1, datasetMappingId: 9 } }]
      }),
      table("core.DatasetMapping")
    ]

    const next = reconcilePlanConflicts(tables, [
      {
        kind: "missing_parent",
        table: "core.DatasetMappingColumn",
        pk: "1",
        parentTable: "core.DatasetMapping",
        childColumn: "datasetMappingId",
        parentPk: "9",
        constraintName: "fk_datasetMappingId"
      }
    ])

    const child = next.find((t) => t.table === "core.DatasetMappingColumn")!
    expect(child.changeSet.insert).toEqual([])
    expect(child.conflicts[0]?.kind).toBe("missing_parent")
    expect(child.conflicts[0]?.summary).toContain("datasetMappingId=9")
  })

  it("ignores missing-parent hits when parent is inserted by this plan", () => {
    const tables = [
      table("core.DatasetMappingColumn", {
        inserts: [{ pk: "1", values: { datasetMappingColumnId: 1, datasetMappingId: 9 } }]
      }),
      table("core.DatasetMapping", {
        inserts: [{ pk: "9", values: { datasetMappingId: 9 } }]
      })
    ]

    const next = reconcilePlanConflicts(tables, [
      {
        kind: "missing_parent",
        table: "core.DatasetMappingColumn",
        pk: "1",
        parentTable: "core.DatasetMapping",
        childColumn: "datasetMappingId",
        parentPk: "9",
        constraintName: "fk_datasetMappingId"
      }
    ])

    expect(next.find((t) => t.table === "core.DatasetMappingColumn")!.conflicts).toEqual([])
    expect(next.find((t) => t.table === "core.DatasetMappingColumn")!.changeSet.insert).toHaveLength(1)
  })
})
