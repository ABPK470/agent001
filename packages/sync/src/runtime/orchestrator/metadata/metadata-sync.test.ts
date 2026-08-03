import { beforeEach, describe, expect, it, vi } from "vitest"

import { EventType } from "../../../domain/enums.js"
import type { WarehouseTx } from "../../../ports/warehouse-tx.js"
import { applyDeletes, applyInsertsUpdates } from "../apply.js"
import { maybeArchive } from "../archive.js"
import { runMetadataSync } from "./metadata-sync.js"

vi.mock("../apply.js", () => ({
  applyInsertsUpdates: vi.fn(),
  applyDeletes: vi.fn()
}))

vi.mock("../archive.js", () => ({
  maybeArchive: vi.fn()
}))

function createTx(queryImpl?: WarehouseTx["query"]): WarehouseTx {
  return {
    dialect: "mssql",
    query: queryImpl ?? (async () => ({ recordset: [], rowsAffected: [0] })),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  }
}

describe("runMetadataSync", () => {
  const applyInsertsUpdatesMock = vi.mocked(applyInsertsUpdates)
  const applyDeletesMock = vi.mocked(applyDeletes)
  const maybeArchiveMock = vi.mocked(maybeArchive)

  beforeEach(() => {
    vi.clearAllMocks()
    applyInsertsUpdatesMock.mockResolvedValue(1)
    applyDeletesMock.mockResolvedValue(0)
    maybeArchiveMock.mockResolvedValue(undefined)
  })

  it("preserves the failing table and step when constraint re-enable fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("ALTER TABLE [core].[Child] CHECK CONSTRAINT ALL")) {
        throw new Error(
          'The ALTER TABLE statement conflicted with the FOREIGN KEY constraint "FK_Child_parent".'
        )
      }
      return { recordset: [], rowsAffected: [0] }
    })
    const tx = createTx(query)

    const eventSink = vi.fn()
    const progress = vi.fn()
    const plan = {
      executionContract: {
        metadata: {
          executionOrder: ["core.Parent", "core.Child"],
          reverseOrder: ["core.Child", "core.Parent"]
        }
      },
      tables: [
        { table: "core.Parent", stats: { unchanged: 0, lowConfidence: 0 }, changeSet: { insert: [{ pk: "1", values: { id: 1 } }], update: [], delete: [] } },
        { table: "core.Child", stats: { unchanged: 0, lowConfidence: 0 }, changeSet: { insert: [{ pk: "2", values: { id: 2 } }], update: [], delete: [] } }
      ]
    } as never

    await expect(
      runMetadataSync({
        host: { sync: { events: { sink: eventSink } } } as never,
        plan,
        planId: "plan-123",
        pkByTable: new Map(),
        triggerCache: new Map(),
        onProgress: progress,
        target: "DEV",
        tx,
        telemetryContext: undefined
      })
    ).rejects.toThrow("metadataSync / check-constraint / core.Child failed")

    expect(eventSink).toHaveBeenCalledWith({
      type: EventType.SyncExecuteStepFailed,
      data: expect.objectContaining({
        planId: "plan-123",
        step: "metadataSync",
        table: "core.Child",
        op: "check-constraint"
      })
    })
    expect(tx.commit).not.toHaveBeenCalled()
    expect(tx.rollback).toHaveBeenCalled()
  })

  it("upserts only tables with insert/update counts", async () => {
    const tx = createTx()
    const plan = {
      executionContract: {
        metadata: {
          executionOrder: ["core.Parent", "core.Child"],
          reverseOrder: ["core.Child", "core.Parent"]
        }
      },
      tables: [
        { table: "core.Parent", stats: { unchanged: 0, lowConfidence: 0 }, changeSet: { insert: [], update: [], delete: [] } },
        { table: "core.Child", stats: { unchanged: 0, lowConfidence: 0 }, changeSet: { insert: [{ pk: "1", values: { id: 1 } }, { pk: "2", values: { id: 2 } }], update: [], delete: [] } }
      ]
    } as never

    await runMetadataSync({
      host: { sync: { events: { sink: vi.fn() } } } as never,
      plan,
      planId: "plan-child-only",
      pkByTable: new Map(),
      triggerCache: new Map(),
      onProgress: vi.fn(),
      target: "DEV",
      tx,
      telemetryContext: undefined
    })

    expect(applyInsertsUpdatesMock).toHaveBeenCalledTimes(1)
    expect(applyInsertsUpdatesMock.mock.calls[0]?.[3]).toBe("core.Child")
    expect(tx.commit).toHaveBeenCalled()
  })
})
