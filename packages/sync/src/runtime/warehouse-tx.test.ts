import { describe, expect, it, vi } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { beginWarehouseTx } from "./warehouse-tx.js"

describe("beginWarehouseTx", () => {
  it("opens a postgres BEGIN/COMMIT transaction on the pool client", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [{ ok: 1 }], rowCount: 1 }
    })
    const release = vi.fn()
    const connect = vi.fn(async () => ({ query, release }))

    const host = {
      mssql: { databases: new Map(), defaultConnection: { value: null } },
      sync: {
        environments: {
          items: new Map([["pg", { name: "pg", connectorId: "p1", role: "both" }]]),
        },
        warehousePools: {
          dialectOf: () => "postgres" as const,
          list: () => [{ id: "p1", name: "pg", dialect: "postgres" as const }],
          get: async () => ({
            dialect: "postgres" as const,
            connectorId: "p1",
            pool: { connect },
            knowledge: null,
          }),
          getByName: async () => {
            throw new Error("unused")
          },
          invalidate: () => {},
        },
      },
    } as unknown as SyncRuntimeHost

    const tx = await beginWarehouseTx(host, "pg")
    expect(connect).toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith("BEGIN")

    const result = await tx.query("SELECT 1")
    expect(result.recordset).toEqual([{ ok: 1 }])

    await tx.commit()
    expect(query).toHaveBeenCalledWith("COMMIT")
    expect(release).toHaveBeenCalled()
  })
})
