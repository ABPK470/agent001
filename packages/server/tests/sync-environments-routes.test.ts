import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHost } from "@mia/agent"
import { createPublishedSyncDefinitionRegistry } from "@mia/sync"
import type { CurrentSession } from "../src/features/auth/index.js"
import * as db from "../src/platform/persistence/db/index.js"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function adminSession(): CurrentSession {
  return {
    sid: "sid-admin",
    displayName: "Admin User",
    upn: "admin@example.com",
    isAdmin: true,
    ip: "127.0.0.1",
    userAgent: "vitest"
  }
}

function createHost(root: string): AgentHost {
  const host = {
    mssql: {
      databases: new Map([
        ["DEV", { config: { server: "dev-sql", database: "mymi" }, writeEnabled: true, knowledge: null }],
        ["UAT", { config: { server: "uat-sql", database: "mymi" }, writeEnabled: true, knowledge: null }]
      ]),
      defaultConnection: { value: "DEV" }
    },
    sync: {
      events: { sink: () => {} },
      runs: { sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null }, actorUpn: null },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: root,
        publishedDefinitions: createPublishedSyncDefinitionRegistry()
      }
    }
  } as unknown as AgentHost
  return host
}

async function seedLiveEnvironments(root: string, host: AgentHost): Promise<void> {
  const { loadPersistedSyncEnvironments } = await import("../src/features/sync/index.js")
  const loaded = loadPersistedSyncEnvironments(root, [
    { name: "DEV", server: "dev-sql", database: "mymi", writeEnabled: true, knowledge: null },
    { name: "UAT", server: "uat-sql", database: "mymi", writeEnabled: true, knowledge: null }
  ])
  host.sync.environments.items = new Map(loaded.environments.map((env) => [env.name, env]))
}

async function buildApp(session: CurrentSession): Promise<{ app: FastifyInstance; host: AgentHost }> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const { registerSyncEnvironmentRoutes } = await import("../src/features/sync/index.js")
  const { seedUser, seedSession } = await import("./_fk-helpers.js")

  _setDb(testDb)
  _migrate(testDb)

  const host = createHost(projectRoot)
  await seedLiveEnvironments(projectRoot, host)
  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
    seedUser(testDb, session.upn, {
      displayName: session.displayName,
      isAdmin: session.isAdmin
    })
    seedSession(testDb, session.sid, session.upn)
  })
  registerSyncEnvironmentRoutes(app, host)
  await app.ready()
  return { app, host }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-sync-env-data-"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-sync-env-root-"))
  mkdirSync(join(projectRoot, "deploy", "sync"), { recursive: true })
  writeFileSync(
    join(projectRoot, "deploy", "sync", "sync-environments.json"),
    JSON.stringify(
      {
        version: 1,
        environments: [
          {
            name: "DEV",
            displayName: "DEV",
            color: "blue",
            role: "both",
            ringOrder: 0,
            allowedSyncTargets: []
          },
          {
            name: "UAT",
            displayName: "UAT",
            color: "teal",
            role: "both",
            ringOrder: 1,
            allowedSyncTargets: ["DEV"]
          }
        ]
      },
      null,
      2
    )
  )
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("sync-environment routes", () => {
  it("updates persisted environments directly instead of writing transient overrides", async () => {
    const { app, host } = await buildApp(adminSession())

    const update = await app.inject({
      method: "PUT",
      url: "/api/sync-environments/UAT?allowBuiltinEdit=true",
      payload: { role: "source", allowedSyncTargets: ["DEV", "PROD"] }
    })
    expect(update.statusCode).toBe(200)
    expect(host.sync.environments.items.get("UAT")?.allowedSyncTargets).toEqual(["DEV", "PROD"])
    expect(host.sync.environments.items.get("UAT")?.role).toBe("source")

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/sync-environments/UAT?allowBuiltinEdit=true"
    })
    expect(remove.statusCode).toBe(200)

    const response = await app.inject({
      method: "GET",
      url: "/api/sync-environments"
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Array<{ name: string }>
    const uat = body.find((env) => env.name === "UAT")
    expect(uat).toBeUndefined()
    expect(host.sync.environments.items.get("UAT")).toBeUndefined()

    await app.close()
  })

  it("does not drift when the legacy JSON file changes after DB seeding", async () => {
    const { app, host } = await buildApp(adminSession())

    writeFileSync(
      join(projectRoot, "deploy", "sync", "sync-environments.json"),
      JSON.stringify(
        {
          version: 1,
          environments: [
            {
              name: "DEV",
              displayName: "DEV",
              color: "blue",
              role: "both",
              ringOrder: 0,
              allowedSyncTargets: ["UAT"]
            },
            {
              name: "UAT",
              displayName: "UAT",
              color: "teal",
              role: "source",
              ringOrder: 1,
              allowedSyncTargets: ["DEV", "PROD"]
            }
          ]
        },
        null,
        2
      )
    )

    const response = await app.inject({
      method: "GET",
      url: "/api/sync-environments"
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as Array<{
      name: string
      role: string
      allowedSyncTargets: string[] | null
    }>
    const uat = body.find((env) => env.name === "UAT")
    expect(uat).toMatchObject({
      name: "UAT",
      role: "both",
      allowedSyncTargets: ["DEV"]
    })
    expect(host.sync.environments.items.get("UAT")?.role).toBe("both")
    expect(host.sync.environments.items.get("UAT")?.allowedSyncTargets).toEqual(["DEV"])

    await app.close()
  })

  it("rejects syncAllowlist in update payloads", async () => {
    const { app } = await buildApp(adminSession())

    const update = await app.inject({
      method: "PUT",
      url: "/api/sync-environments/UAT?allowBuiltinEdit=true",
      payload: { syncAllowlist: [] },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json()).toMatchObject({ error: expect.stringContaining('removed field "syncAllowlist"') })

    await app.close()
  })

  it("strips legacy syncAllowlist from stored rows on read and write", async () => {
    const { app } = await buildApp(adminSession())
    const now = new Date().toISOString()
    db.saveSyncEnvironment({
      name: "UAT",
      body_json: JSON.stringify({
        name: "UAT",
        displayName: "UAT",
        color: "teal",
        role: "both",
        ringOrder: 1,
        syncAllowlist: ["ghost@example.com"],
        allowedSyncTargets: ["DEV"],
        defaultAccessMode: "read_write",
        allowedOperations: ["query_read"],
        denyDml: false,
        denyDdl: false,
        approvalRequiredOperations: [],
      }),
      created_at: now,
      updated_at: now,
      updated_by: "seed",
    })

    const listed = await app.inject({ method: "GET", url: "/api/sync-environments" })
    expect(listed.statusCode).toBe(200)
    const uat = (listed.json() as Array<Record<string, unknown>>).find((env) => env.name === "UAT")
    expect(uat).toBeTruthy()
    expect(uat).not.toHaveProperty("syncAllowlist")

    const updated = await app.inject({
      method: "PUT",
      url: "/api/sync-environments/UAT?allowBuiltinEdit=true",
      payload: { displayName: "UAT cleaned" },
    })
    expect(updated.statusCode).toBe(200)

    const row = db.getSyncEnvironment("UAT")
    expect(row).toBeTruthy()
    const stored = JSON.parse(row!.body_json) as Record<string, unknown>
    expect(stored).not.toHaveProperty("syncAllowlist")
    expect(stored.displayName).toBe("UAT cleaned")

    await app.close()
  })
})
