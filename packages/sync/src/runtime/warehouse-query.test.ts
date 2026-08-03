import { describe, expect, it, vi } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { runWarehouseQuery } from "./warehouse-query.js"

describe("runWarehouseQuery", () => {
  it("dispatches to postgres pool.query when dialect is postgres", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 }))
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
            pool: { query },
            knowledge: null,
          }),
          getByName: async () => {
            throw new Error("unused")
          },
          invalidate: () => {},
        },
      },
    } as unknown as SyncRuntimeHost

    const result = await runWarehouseQuery(host, "pg", "SELECT 1")
    expect(query).toHaveBeenCalledWith("SELECT 1")
    expect(result.recordset).toEqual([{ id: 1 }])
    expect(result.rowsAffected).toEqual([1])
  })

  it("dispatches to mssql pool.request().query when dialect is mssql", async () => {
    const query = vi.fn(async () => ({ recordset: [{ id: 2 }], rowsAffected: [1] }))
    const request = vi.fn(() => ({ query }))
    const host = {
      mssql: { databases: new Map(), defaultConnection: { value: null } },
      sync: {
        environments: {
          items: new Map([["ms", { name: "ms", connectorId: "m1", role: "both" }]]),
        },
        warehousePools: {
          dialectOf: () => "mssql" as const,
          list: () => [{ id: "m1", name: "ms", dialect: "mssql" as const }],
          get: async () => ({
            dialect: "mssql" as const,
            connectorId: "m1",
            pool: { request },
            knowledge: null,
          }),
          getByName: async () => {
            throw new Error("unused")
          },
          invalidate: () => {},
        },
      },
    } as unknown as SyncRuntimeHost

    const result = await runWarehouseQuery(host, "ms", "SELECT 2")
    expect(request).toHaveBeenCalled()
    expect(query).toHaveBeenCalledWith("SELECT 2")
    expect(result.recordset).toEqual([{ id: 2 }])
  })
})
