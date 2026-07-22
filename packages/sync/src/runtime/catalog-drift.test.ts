import { describe, expect, it, vi } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { ALWAYS_PUBLISH_READY } from "../domain/publish-readiness.js"
import { createPublishedSyncDefinitionRegistry } from "./published-definition-registry.js"

const queryMock = vi.fn()
const capturedSql: string[] = []

vi.mock("../adapters/mssql/connection.js", () => ({
  getPool: vi.fn(async (_host: unknown, connection: string) => ({
    pool: {
      request() {
        return {
          query: async (sql: string) => {
            capturedSql.push(sql)
            return { recordset: queryMock(connection) }
          }
        }
      }
    }
  }))
}))

import { detectCatalogDrift } from "./catalog-drift.js"

function createHost(): SyncRuntimeHost {
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: null }
    },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: {
          start: () => {},
          finish: () => {}
        },
        actorUpn: null
      },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: null,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
        publishReadiness: ALWAYS_PUBLISH_READY,
      }
    }
  }
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
            CHARACTER_MAXIMUM_LENGTH: null
          }
        ]
      }
      return [
        {
          TABLE_SCHEMA: "gate",
          TABLE_NAME: "jsonSchema",
          COLUMN_NAME: "JsonSchemaId",
          DATA_TYPE: "int",
          CHARACTER_MAXIMUM_LENGTH: null
        }
      ]
    })

    const result = await detectCatalogDrift(createHost(), "source", "target", ["gate.jsonSchema"], ["gate"])

    expect(result).toEqual({
      catalogCompatible: true,
      issues: []
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
        CHARACTER_MAXIMUM_LENGTH: null
      }
    ])

    await detectCatalogDrift(createHost(), "source", "target", ["core.Contract"], ["core"])

    expect(capturedSql.some((sql) => sql.includes("LOWER(TABLE_SCHEMA + '.' + TABLE_NAME) IN"))).toBe(true)
    expect(capturedSql.some((sql) => sql.includes("TABLE_SCHEMA IN"))).toBe(false)
  })
})
