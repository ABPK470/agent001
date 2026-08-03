import { describe, expect, it } from "vitest"

import { createMssqlWarehouseDialect } from "../adapters/mssql/dialect/index.js"
import { createPostgresWarehouseDialect } from "../adapters/postgres/dialect/index.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import { resolveWarehouseDialect } from "./warehouse-dialect.js"

describe("resolveWarehouseDialect", () => {
  it("picks postgres when the env connector is postgres", () => {
    const host = {
      mssql: { databases: new Map(), defaultConnection: { value: null } },
      sync: {
        environments: {
          items: new Map([["pg", { name: "pg", connectorId: "pg-1", role: "both" }]]),
        },
        warehouseDialect: createMssqlWarehouseDialect(),
        warehousePools: {
          dialectOf: (id: string) => (id === "pg-1" ? "postgres" : undefined),
          list: () => [{ id: "pg-1", name: "pg", dialect: "postgres" as const }],
          get: async () => ({ dialect: "postgres" as const, connectorId: "pg-1", pool: null, knowledge: null }),
          getByName: async () => ({ dialect: "postgres" as const, connectorId: "pg-1", pool: null, knowledge: null }),
          invalidate: () => {},
        },
      },
    } as unknown as SyncRuntimeHost

    expect(resolveWarehouseDialect(host, "pg").kind).toBe("postgres")
    expect(resolveWarehouseDialect(host).kind).toBe("mssql")
  })

  it("falls back to host dialect when pools are absent", () => {
    const host = {
      mssql: { databases: new Map(), defaultConnection: { value: null } },
      sync: {
        environments: { items: new Map() },
        warehouseDialect: createPostgresWarehouseDialect(),
      },
    } as unknown as SyncRuntimeHost
    expect(resolveWarehouseDialect(host).kind).toBe("postgres")
  })
})
