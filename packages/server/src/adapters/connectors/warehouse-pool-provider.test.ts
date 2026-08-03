import { describe, expect, it, vi } from "vitest"

import { createWarehousePoolProvider } from "./warehouse-pool-provider.js"
import type { PostgresPoolProvider } from "./postgres-pool-provider.js"
import type { MssqlPoolProvider } from "@mia/agent"

describe("createWarehousePoolProvider", () => {
  it("lists mssql and postgres connectors with dialect tags", async () => {
    const mssql: MssqlPoolProvider = {
      get: vi.fn(),
      getByName: vi.fn(),
      list: async () => [{ id: "m1", name: "mssql-dev" }],
      configOf: async () => undefined,
      invalidate: vi.fn(),
    }
    const postgres: PostgresPoolProvider = {
      get: vi.fn(async () => ({
        connectorId: "p1",
        pool: {} as never,
        config: {},
        knowledge: null,
      })),
      getByName: vi.fn(),
      list: async () => [{ id: "p1", name: "pg-dev" }],
      invalidate: vi.fn(),
      closeAll: vi.fn(async () => {}),
    }

    const warehouse = createWarehousePoolProvider({ mssql, postgres })
    expect(await warehouse.list()).toEqual([
      { id: "m1", name: "mssql-dev", dialect: "mssql" },
      { id: "p1", name: "pg-dev", dialect: "postgres" },
    ])
    expect(warehouse.dialectOf("p1")).toBe("postgres")
    expect(warehouse.dialectOf("m1")).toBe("mssql")
    expect(warehouse.dialectOf("missing")).toBeUndefined()
  })

  it("routes get() to the matching provider", async () => {
    const mssqlGet = vi.fn(async () => ({
      connectorId: "m1",
      pool: {} as never,
      config: {},
      knowledge: null,
    }) as never)
    const mssql: MssqlPoolProvider = {
      get: mssqlGet,
      getByName: vi.fn(),
      list: async () => [{ id: "m1", name: "mssql-dev" }],
      configOf: async () => undefined,
      invalidate: vi.fn(),
    }
    const postgres: PostgresPoolProvider = {
      get: vi.fn(),
      getByName: vi.fn(),
      list: async () => [],
      invalidate: vi.fn(),
      closeAll: vi.fn(async () => {}),
    }
    const warehouse = createWarehousePoolProvider({ mssql, postgres })
    const handle = await warehouse.get("m1")
    expect(handle.dialect).toBe("mssql")
    expect(mssqlGet).toHaveBeenCalledWith("m1")
  })
})
