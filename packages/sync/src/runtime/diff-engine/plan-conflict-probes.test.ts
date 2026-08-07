import { beforeEach, describe, expect, it, vi } from "vitest"

const runQueryMock = vi.fn()

vi.mock("./sql-query.js", () => ({
  runQueryWithRetry: (...args: unknown[]) => runQueryMock(...args)
}))

import { applyPlanConflictProbes } from "./plan-conflict-probes.js"
import type { SyncPlanTable } from "../../domain/plan.js"
import type { SyncRuntimeHost } from "../../ports/host.js"

/** Minimal host — probes only need sync.environments for dialect resolution. */
const probeHost = {
  sync: { environments: { items: new Map() } },
} as unknown as SyncRuntimeHost

function table(
  name: string,
  opts: {
    deletes?: Array<{ pk: string; values: Record<string, unknown> }>
    inserts?: Array<{ pk: string; values: Record<string, unknown> }>
  } = {}
): SyncPlanTable {
  return {
    table: name,
    scopePredicate: "x = 1",
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

describe("applyPlanConflictProbes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("surfaces inbound blockers with owner keys", async () => {
    runQueryMock
      // inbound FK discovery for DatasetColumn
      .mockResolvedValueOnce({
        recordset: [
          {
            fromSchema: "core",
            fromName: "DatasetMappingColumn",
            fromColumn: "datasetColumnId_right",
            toSchema: "core",
            toName: "DatasetColumn",
            toColumn: "datasetColumnId",
            constraintName: "fk_datasetColumnId_right",
            fkColumnCount: 1
          }
        ]
      })
      // PK of DatasetMappingColumn
      .mockResolvedValueOnce({
        recordset: [{ name: "datasetMappingColumnId" }]
      })
      // outbound FKs of DatasetMappingColumn (owners)
      .mockResolvedValueOnce({
        recordset: [
          {
            fromSchema: "core",
            fromName: "DatasetMappingColumn",
            fromColumn: "datasetMappingId",
            toSchema: "core",
            toName: "DatasetMapping",
            toColumn: "datasetMappingId",
            constraintName: "fk_datasetMappingId",
            fkColumnCount: 1
          },
          {
            fromSchema: "core",
            fromName: "DatasetMappingColumn",
            fromColumn: "datasetColumnId_right",
            toSchema: "core",
            toName: "DatasetColumn",
            toColumn: "datasetColumnId",
            constraintName: "fk_datasetColumnId_right",
            fkColumnCount: 1
          }
        ]
      })
      // inbound hit rows
      .mockResolvedValueOnce({
        recordset: [
          {
            pk_datasetMappingColumnId: 99,
            blockedPk: 10,
            owner_datasetMappingId: 7
          }
        ]
      })

    const { tables, probeWarnings } = await applyPlanConflictProbes(probeHost, "mymi", [
      table("core.DatasetColumn", { deletes: [{ pk: "10", values: { datasetColumnId: 10 } }] }),
      table("core.DatasetMappingColumn")
    ])

    expect(probeWarnings).toEqual([])
    const col = tables.find((t) => t.table === "core.DatasetColumn")!
    expect(col.changeSet.delete).toEqual([])
    expect(col.conflicts[0]?.kind).toBe("inbound_reference")
    expect(col.conflicts[0]?.actualScope).toMatchObject({
      owners: { datasetMappingId: 7 }
    })
  })

  it("surfaces missing-parent blockers for inserts", async () => {
    runQueryMock
      // outbound FKs from DatasetMappingColumn
      .mockResolvedValueOnce({
        recordset: [
          {
            fromSchema: "core",
            fromName: "DatasetMappingColumn",
            fromColumn: "datasetMappingId",
            toSchema: "core",
            toName: "DatasetMapping",
            toColumn: "datasetMappingId",
            constraintName: "fk_datasetMappingId",
            fkColumnCount: 1
          }
        ]
      })
      // parent lookup — empty ⇒ missing
      .mockResolvedValueOnce({ recordset: [] })

    const { tables } = await applyPlanConflictProbes(probeHost, "mymi", [
      table("core.DatasetMappingColumn", {
        inserts: [{ pk: "1", values: { datasetMappingColumnId: 1, datasetMappingId: 9 } }]
      }),
      table("core.DatasetMapping")
    ])

    const child = tables.find((t) => t.table === "core.DatasetMappingColumn")!
    expect(child.changeSet.insert).toEqual([])
    expect(child.conflicts[0]?.kind).toBe("missing_parent")
  })

  it("emits probeWarnings instead of silent empty on discovery failure", async () => {
    runQueryMock.mockRejectedValueOnce(new Error("permission denied"))

    const { tables, probeWarnings } = await applyPlanConflictProbes(probeHost, "mymi", [
      table("core.DatasetColumn", { deletes: [{ pk: "10", values: { datasetColumnId: 10 } }] })
    ])

    expect(tables[0]?.conflicts).toEqual([])
    expect(probeWarnings[0]).toContain("[conflict-probe] inbound failed")
    expect(probeWarnings[0]).toContain("permission denied")
  })
})
