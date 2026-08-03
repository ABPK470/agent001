import { describe, expect, it, vi } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { ALWAYS_PUBLISH_READY } from "../ports/publish-readiness.js"
import { createPublishedSyncDefinitionRegistry } from "./published-definition-registry.js"
import { detectCatalogDrift } from "./catalog-drift.js"

const queryMock = vi.fn()
const capturedSql: string[] = []

function createHost(): SyncRuntimeHost {
  const envItems = new Map([
    ["source", { name: "source", connectorId: "src", role: "both" as const }],
    ["target", { name: "target", connectorId: "tgt", role: "both" as const }],
  ])

  function poolFor(connectorId: string) {
    const connection = connectorId === "src" ? "source" : "target"
    return {
      request() {
        return {
          query: async (sql: string) => {
            capturedSql.push(sql)
            return { recordset: queryMock(connection), rowsAffected: [0] }
          },
        }
      },
    }
  }

  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: null },
    },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: {
          start: () => {},
          finish: () => {},
        },
        actorUpn: null,
      },
      environments: { items: envItems },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: null,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
        publishReadiness: ALWAYS_PUBLISH_READY,
      },
      warehousePools: {
        dialectOf: (id: string) => (id === "src" || id === "tgt" ? ("mssql" as const) : undefined),
        list: () => [
          { id: "src", name: "source", dialect: "mssql" as const },
          { id: "tgt", name: "target", dialect: "mssql" as const },
        ],
        get: async (connectorId: string) => ({
          dialect: "mssql" as const,
          connectorId,
          pool: poolFor(connectorId),
          knowledge: null,
        }),
        getByName: async () => {
          throw new Error("unused")
        },
        invalidate: () => {},
      },
    },
  } as unknown as SyncRuntimeHost
}

describe("detectCatalogDrift", () => {
  it("treats MSSQL table and column names as case-insensitive", async () => {
    queryMock.mockImplementation((connection: string) => {
      if (connection === "source") {
        return [
          {
            TABLE_SCHEMA: "gate",
            TABLE_NAME: "JsonSchema",
            COLUMN_NAME: "jsonSchemaId",
            DATA_TYPE: "int",
            CHARACTER_MAXIMUM_LENGTH: null,
          },
        ]
      }
      return [
        {
          TABLE_SCHEMA: "gate",
          TABLE_NAME: "jsonSchema",
          COLUMN_NAME: "JsonSchemaId",
          DATA_TYPE: "int",
          CHARACTER_MAXIMUM_LENGTH: null,
        },
      ]
    })

    const result = await detectCatalogDrift(createHost(), "source", "target", ["gate.jsonSchema"], ["gate"])

    expect(result).toEqual({
      catalogCompatible: true,
      issues: [],
    })
  })

  it("queries only restrictTables instead of whole schemas when a recipe is provided", async () => {
    capturedSql.length = 0
    queryMock.mockReturnValue([
      {
        TABLE_SCHEMA: "core",
        TABLE_NAME: "Contract",
        COLUMN_NAME: "contractId",
        DATA_TYPE: "int",
        CHARACTER_MAXIMUM_LENGTH: null,
      },
    ])

    await detectCatalogDrift(createHost(), "source", "target", ["core.Contract"], ["core"])

    expect(capturedSql.some((sql) => sql.includes("LOWER(TABLE_SCHEMA + '.' + TABLE_NAME) IN"))).toBe(true)
    expect(capturedSql.some((sql) => sql.includes("TABLE_SCHEMA IN"))).toBe(false)
  })
})
