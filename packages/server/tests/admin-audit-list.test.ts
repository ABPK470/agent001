import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  countAuditLog,
  listAuditLogPaginated,
  saveAdminAudit,
  saveAudit,
} from "../src/infra/persistence/db/runs.js"
import { seedRun, seedUser } from "./_fk-helpers.js"

let testDb: Database.Database

describe("admin audit list", () => {
  beforeEach(async () => {
    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)

    seedUser(testDb, "alice@x", { displayName: "Alice" })
    seedUser(testDb, "bob@x", { displayName: "Bob" })
    seedRun(testDb, "run-a", { upn: "alice@x", goal: "deploy contract" })
    seedRun(testDb, "run-b", { upn: "bob@x", goal: "sync entity" })

    saveAudit({
      run_id: "run-a",
      actor: "agent",
      action: "tool.completed",
      detail: JSON.stringify({ tool: "mssql_query" }),
      timestamp: "2026-07-10T10:00:00",
    })
    saveAudit({
      run_id: "run-b",
      actor: "user",
      action: "tool.denied",
      detail: JSON.stringify({ reason: "policy" }),
      timestamp: "2026-07-11T12:00:00",
    })
    saveAdminAudit({
      actor: "alice@x",
      action: "policy.create",
      detail: JSON.stringify({ name: "deny-shell" }),
      timestamp: "2026-07-12T09:00:00",
      scope_id: "policies",
    })
  })

  afterEach(() => {
    testDb.close()
  })

  it("lists all scopes by default, newest first", () => {
    const rows = listAuditLogPaginated({ page: 1, pageSize: 50 })
    expect(rows).toHaveLength(3)
    expect(rows[0]?.action).toBe("policy.create")
    expect(rows[0]?.scope_type).toBe("admin")
    expect(countAuditLog()).toBe(3)
  })

  it("filters by scope type and scope id", () => {
    const rows = listAuditLogPaginated({
      page: 1,
      pageSize: 50,
      scopeType: "admin",
      scopeId: "policies",
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.action).toBe("policy.create")
  })

  it("filters by user UPN across run owner and admin actor", () => {
    const bobRows = listAuditLogPaginated({
      page: 1,
      pageSize: 50,
      user: "bob@x",
      from: "2026-07-11",
      to: "2026-07-11",
    })
    expect(bobRows).toHaveLength(1)
    expect(bobRows[0]?.run_id).toBe("run-b")
    expect(bobRows[0]?.action).toBe("tool.denied")

    const aliceRows = listAuditLogPaginated({
      page: 1,
      pageSize: 50,
      user: "alice@x",
    })
    expect(aliceRows.map((r) => r.action).sort()).toEqual(["policy.create", "tool.completed"])
  })

  it("searches across action / detail / goal", () => {
    const rows = listAuditLogPaginated({
      page: 1,
      pageSize: 50,
      search: "contract",
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.run_id).toBe("run-a")
  })

  it("supports action prefix match", () => {
    const rows = listAuditLogPaginated({
      page: 1,
      pageSize: 50,
      action: "tool.",
    })
    expect(rows).toHaveLength(2)
  })
})
