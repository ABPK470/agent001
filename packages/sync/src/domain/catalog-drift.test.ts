import { describe, expect, it, vi } from "vitest"

import type { SyncRuntimeHost } from "../ports/host.js"
import { createPublishedSyncDefinitionRegistry } from "./published-definition-registry.js"

const queryMock = vi.fn()

vi.mock("../ports/index.js", () => ({
  getPool: vi.fn(async (_host: unknown, connection: string) => ({
    pool: {
      request() {
        return {
          query: async (_sql: string) => ({ recordset: queryMock(connection) }),
        }
      },
    },
  })),
}))

import { detectCatalogDrift } from "./catalog-drift.js"

function createHost(): SyncRuntimeHost {
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
      },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: null,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
      },
    },
  }
}

describe("detectCatalogDrift", () => {
  it("treats MSSQL table and column names as case-insensitive", async () => {
    queryMock.mockImplementation((connection: string) => {
      if (connection === "source") {
        return [
          { TABLE_SCHEMA: "gate", TABLE_NAME: "JsonSchema", COLUMN_NAME: "jsonSchemaId", DATA_TYPE: "int", CHARACTER_MAXIMUM_LENGTH: null },
        ]
      }
      return [
        { TABLE_SCHEMA: "gate", TABLE_NAME: "jsonSchema", COLUMN_NAME: "JsonSchemaId", DATA_TYPE: "int", CHARACTER_MAXIMUM_LENGTH: null },
      ]
    })

    const result = await detectCatalogDrift(
      createHost(),
      "source",
      "target",
      ["gate.jsonSchema"],
      ["gate"],
    )

    expect(result).toEqual({
      catalogCompatible: true,
      issues: [],
    })
  })
})