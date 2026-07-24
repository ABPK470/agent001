import { beforeEach, describe, expect, it, vi } from "vitest"

const runQueryMock = vi.fn()

vi.mock("./sql-query.js", () => ({
  runQueryWithRetry: (...args: unknown[]) => runQueryMock(...args)
}))

import { applyInboundDeleteBlockers } from "./inbound-delete-blockers.js"
import type { SyncPlanTable } from "../../domain/plan.js"

function table(
  name: string,
  deletes: Array<{ pk: string; values: Record<string, unknown> }>
): SyncPlanTable {
  return {
    table: name,
    scopePredicate: "datasetId = 1",
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: { insert: [], update: [], delete: deletes },
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings: [],
    diffDurationMs: 0
  }
}

describe("applyInboundDeleteBlockers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("surfaces DatasetMappingColumn.datasetColumnId_right blockers without expanding scope", async () => {
    runQueryMock
      .mockResolvedValueOnce({
        recordset: [
          {
            referencingSchema: "core",
            referencingName: "DatasetMappingColumn",
            referencingColumn: "datasetColumnId_right",
            referencedColumn: "datasetColumnId",
            constraintName: "fk_datasetColumnId_right",
            fkColumnCount: 1
          },
          {
            referencingSchema: "core",
            referencingName: "DatasetMappingColumn",
            referencingColumn: "datasetColumnId_Left",
            referencedColumn: "datasetColumnId",
            constraintName: "fk_datasetColumnId_Left",
            fkColumnCount: 1
          }
        ]
      })
      .mockResolvedValueOnce({
        recordset: [{ name: "datasetMappingColumnId" }]
      })
      .mockResolvedValueOnce({
        recordset: [{ pk_datasetMappingColumnId: 99, blockedPk: 10 }]
      })
      .mockResolvedValueOnce({
        recordset: []
      })

    const next = await applyInboundDeleteBlockers({} as never, "mymi", [
      table("core.DatasetColumn", [{ pk: "10", values: { datasetColumnId: 10 } }]),
      table("core.DatasetMappingColumn", [])
    ])

    const datasetColumn = next.find((t) => t.table === "core.DatasetColumn")!
    expect(datasetColumn.changeSet.delete).toEqual([])
    expect(datasetColumn.conflicts).toHaveLength(1)
    expect(datasetColumn.conflicts[0]?.kind).toBe("inbound_reference")
    expect(datasetColumn.conflicts[0]?.summary).toContain("fk_datasetColumnId_right")
    expect(datasetColumn.conflicts[0]?.summary).toContain("outside this plan's owned scope")

    // Discovery + PK of referencing table + one probe per inbound FK column.
    expect(runQueryMock).toHaveBeenCalledTimes(4)
    expect(String(runQueryMock.mock.calls[2]?.[2])).toContain("datasetColumnId_right")
    expect(String(runQueryMock.mock.calls[3]?.[2])).toContain("datasetColumnId_Left")
  })

  it("skips tables with no deletes", async () => {
    const next = await applyInboundDeleteBlockers({} as never, "mymi", [
      table("core.DatasetColumn", [])
    ])
    expect(next[0]?.conflicts).toEqual([])
    expect(runQueryMock).not.toHaveBeenCalled()
  })
})
