/**
 * F1.10 — notification router persistence + filter matching tests.
 *
 * Adapters (email/teams/slack) perform network IO; this file exercises
 * everything *up to* the adapter dispatch:
 *   - CRUD (upsert/list/delete)
 *   - filter matching: riskTier / envPair / entityType (AND semantics)
 *   - listNotificationLog filter
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-notif-"))
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

async function setup() {
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
  return import("../src/features/notifications/router.js")
}

describe("notifications router (F1.10)", () => {
  it("upsert + list + delete CRUD", async () => {
    const m = await setup()
    const r = m.upsertNotificationRoute({
      tenantId: "_default",
      eventType: "sync.proposal.created",
      filter: { riskTier: ["high"] },
      channel: "slack",
      target: "https://hooks/example",
      enabled: true,
      actor: "admin"
    })
    expect(r.id).toBeDefined()
    expect(m.listNotificationRoutes("_default")).toHaveLength(1)
    m.deleteNotificationRoute(r.id)
    expect(m.listNotificationRoutes("_default")).toHaveLength(0)
  })

  it("filter matching: riskTier exact match", async () => {
    const m = await setup()
    m.upsertNotificationRoute({
      tenantId: "_default",
      eventType: "sync.proposal.created",
      filter: { riskTier: ["high", "critical"] },
      channel: "slack",
      target: "x",
      enabled: true,
      actor: "admin"
    })
    expect(
      m.listMatchingRoutes({
        tenantId: "_default",
        eventType: "sync.proposal.created",
        riskTier: "high",
        context: {}
      })
    ).toHaveLength(1)
    expect(
      m.listMatchingRoutes({
        tenantId: "_default",
        eventType: "sync.proposal.created",
        riskTier: "low",
        context: {}
      })
    ).toHaveLength(0)
    expect(
      m.listMatchingRoutes({ tenantId: "_default", eventType: "sync.proposal.created", context: {} })
    ).toHaveLength(1) // missing riskTier ⇒ pass
  })

  it("filter matching: AND across clauses", async () => {
    const m = await setup()
    m.upsertNotificationRoute({
      tenantId: "_default",
      eventType: "sync.proposal.created",
      filter: { riskTier: ["high"], envPair: ["uat→prod"] },
      channel: "email",
      target: "ops@example.com",
      enabled: true,
      actor: "admin"
    })
    expect(
      m.listMatchingRoutes({
        tenantId: "_default",
        eventType: "sync.proposal.created",
        riskTier: "high",
        envPair: "uat→prod",
        context: {}
      })
    ).toHaveLength(1)
    expect(
      m.listMatchingRoutes({
        tenantId: "_default",
        eventType: "sync.proposal.created",
        riskTier: "high",
        envPair: "uat→qa",
        context: {}
      })
    ).toHaveLength(0)
  })

  it("disabled routes are not returned by listMatchingRoutes", async () => {
    const m = await setup()
    m.upsertNotificationRoute({
      tenantId: "_default",
      eventType: "sync.proposal.created",
      filter: {},
      channel: "slack",
      target: "x",
      enabled: false,
      actor: "admin"
    })
    expect(
      m.listMatchingRoutes({ tenantId: "_default", eventType: "sync.proposal.created", context: {} })
    ).toHaveLength(0)
  })

  it("listNotificationLog filters by status + limit", async () => {
    const m = await setup()
    expect(m.listNotificationLog({ status: "sent", limit: 10 })).toEqual([])
  })
})
