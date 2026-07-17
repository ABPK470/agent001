import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CurrentSession } from "../src/api/auth/index.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]
const repoRoot = resolve(import.meta.dirname, "../../..")

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin User",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest",
  }
}

async function buildApp(session: CurrentSession): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  const { registerEntityRegistryRoutes } = await import("../src/api/sync/index.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, {
      displayName: session.displayName,
      isAdmin: session.isAdmin,
    })
    seedSession(testDb, session.sid, session.upn)
  })
  registerEntityRegistryRoutes(app, repoRoot)
  await app.ready()
  return app
}

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "mia-entity-registry-suggest-data-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("entity registry suggest-draft route", () => {
  it("returns heuristic identity and root table without catalog", async () => {
    const app = await buildApp(adminSession())

    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/suggest-draft?rootTable=core.Contract",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      identity: { id: string; idColumn: string }
      tables: Array<{ name: string }>
      flowTemplateId: string | null
      source: string
    }
    expect(body.identity).toMatchObject({ id: "contract", idColumn: "contractId" })
    expect(body.flowTemplateId).toBe("contract")
    expect(body.source).toBe("heuristic")
    expect(body.tables).toHaveLength(1)
    expect(body.tables[0]?.name).toBe("core.Contract")
  })

  it("uses catalog cache when present", async () => {
    writeFileSync(
      resolve(dataDir, "catalog-cache.json"),
      JSON.stringify({
        version: 7,
        tables: [
          {
            schema: "core",
            name: "Dataset",
            qualifiedName: "core.Dataset",
            columns: [{ name: "datasetId", isPK: true }, { name: "name", isPK: false }],
            fkOutgoing: [],
          },
          {
            schema: "core",
            name: "Pipeline",
            qualifiedName: "core.Pipeline",
            columns: [{ name: "pipelineId", isPK: true }, { name: "datasetId", isPK: false }],
            fkOutgoing: [
              {
                fromSchema: "core",
                fromTable: "Pipeline",
                fromColumn: "datasetId",
                toSchema: "core",
                toTable: "Dataset",
                toColumn: "datasetId",
              },
            ],
          },
        ],
      }),
      "utf8",
    )

    const app = await buildApp(adminSession())
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/suggest-draft?rootTable=core.Dataset",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      source: string
      tables: Array<{ name: string }>
    }
    expect(body.source).toBe("catalog")
    expect(body.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["core.Dataset", "core.Pipeline"]),
    )
  })
})

describe("entity registry suggest-table route", () => {
  it("suggests root PK scope for entity root table", async () => {
    const app = await buildApp(adminSession())
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/suggest-table?rootTable=core.Dataset&idColumn=datasetId&tableName=core.Dataset&executionOrder=1",
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { table: { scope: { kind: string; column: string } } }
    expect(body.table.scope).toEqual({ kind: "rootPk", column: "datasetId" })
  })
})
