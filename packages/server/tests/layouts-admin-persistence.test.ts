/**
 * Regression test (v19) — layout persistence across logout/login.
 *
 * v19 collapse: every authenticated user — admin or not — has a stable
 * `dashboard:${upn}` key. The old `dashboard:admin` special bucket is
 * gone (it was the workaround for unverified anon-admin via access code).
 *
 * What we pin:
 *   1. Same upn → same key, regardless of sid drift across re-login.
 *   2. Admin uses their own upn key (no shared `dashboard:admin` bucket).
 *   3. Two distinct upns are isolated.
 */

import Database from "better-sqlite3"
import Fastify, { type FastifyInstance } from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CurrentSession } from "../src/features/auth/index.js"
import { seedUser } from "./_fk-helpers.js"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

async function buildApp(session: CurrentSession): Promise<FastifyInstance> {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  const { registerLayoutRoutes } = await import("../src/features/layouts/routes.js")
  _setDb(testDb)
  _migrate(testDb)

  const app = Fastify({ logger: false })
  app.addHook("onRequest", async (req) => {
    ;(req as unknown as { session: CurrentSession }).session = session
  })
  registerLayoutRoutes(app)
  await app.ready()
  return app
}

function session(over: Partial<CurrentSession> & { upn: string }): CurrentSession {
  return {
    sid: over.sid ?? "sid-test",
    displayName: over.displayName ?? over.upn,
    upn: over.upn,
    isAdmin: over.isAdmin ?? false,
    ip: over.ip ?? "127.0.0.1",
    userAgent: over.userAgent ?? "vitest"
  }
}

const SAMPLE_VIEWS = [{ id: "main", name: "Main", widgets: [{ id: "w1", type: "live-logs" }], layouts: {} }]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-layouts-admin-"))
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

describe("layouts (v19) — per-upn persistence across logout/login", () => {
  it("same upn → layout survives sid drift across re-login", async () => {
    const upn = "alice@corp"
    const app1 = await buildApp(session({ upn, sid: "sid-A", isAdmin: true }))
    seedUser(testDb, upn, { isAdmin: true })
    const put = await app1.inject({
      method: "PUT",
      url: "/api/dashboard-state",
      payload: { views: SAMPLE_VIEWS, activeViewId: "main" }
    })
    expect(put.statusCode).toBe(200)

    const app2 = await buildApp(session({ upn, sid: "sid-B-after-relogin", isAdmin: true }))
    const get = await app2.inject({ method: "GET", url: "/api/dashboard-state" })
    expect(get.statusCode).toBe(200)
    const body = get.json() as { views?: unknown[]; activeViewId?: string } | null
    expect(body?.activeViewId).toBe("main")
    expect(body?.views).toEqual(SAMPLE_VIEWS)
  })

  it("admin layout is keyed by their upn — NOT by the literal 'dashboard:admin'", async () => {
    const upn = "root@corp"
    const app = await buildApp(session({ upn, isAdmin: true }))
    seedUser(testDb, upn, { isAdmin: true })
    await app.inject({
      method: "PUT",
      url: "/api/dashboard-state",
      payload: { views: SAMPLE_VIEWS, activeViewId: "main" }
    })

    const { getLayout } = await import("../src/platform/persistence/db/config.js")
    const expectedKey = `dashboard:${upn.toLowerCase()}`
    const row = getLayout(expectedKey)
    expect(row, `PUT must write to id='${expectedKey}'`).toBeDefined()
    expect(JSON.parse(row!.config).views).toEqual(SAMPLE_VIEWS)

    const legacy = getLayout("dashboard:admin")
    expect(legacy, "legacy 'dashboard:admin' bucket must NOT be written in v19").toBeUndefined()
  })

  it("two distinct upns are isolated (cross-tenancy)", async () => {
    const adminApp = await buildApp(session({ upn: "alice@corp", isAdmin: true }))
    seedUser(testDb, "alice@corp", { isAdmin: true })
    seedUser(testDb, "bob@corp")
    await adminApp.inject({
      method: "PUT",
      url: "/api/dashboard-state",
      payload: { views: SAMPLE_VIEWS, activeViewId: "main" }
    })

    const otherApp = await buildApp(session({ upn: "bob@corp", isAdmin: false }))
    const get = await otherApp.inject({ method: "GET", url: "/api/dashboard-state" })
    const body = get.json() as { views?: unknown[] } | null
    expect(body?.views ?? null).not.toEqual(SAMPLE_VIEWS)
  })
})
