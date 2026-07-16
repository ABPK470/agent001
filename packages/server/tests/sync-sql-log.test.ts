import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { backfillSyncSqlEventLogLinks } from "../src/platform/persistence/db/sync-sql-log-backfill.js"
import {
  countSyncSqlLogByPlan,
  enrichSyncSqlEventData,
  getSyncSqlLog,
  hydratePersistedSqlEventData,
  listSyncSqlLogByPlan,
  recordSyncSqlLog,
} from "../src/platform/persistence/db/sync-sql-log.js"

let testDb: Database.Database

function saveEvent(type: string, data: Record<string, unknown>, createdAt: string): number {
  const result = testDb
    .prepare("INSERT INTO event_log (type, data, created_at) VALUES (?, ?, ?)")
    .run(type, JSON.stringify(data), createdAt)
  return Number(result.lastInsertRowid)
}

describe("sync-sql-log", () => {
  beforeEach(async () => {
    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it("stores full SQL and strips __fullSql from broadcast payload", () => {
    const data = enrichSyncSqlEventData("sync.preview.sql", {
      planId: "plan-1",
      previewId: "prev-1",
      label: "diff.hash(core.Activity)",
      connection: "uat",
      sql: "SELECT 1… [+10 chars]",
      sqlLength: 20,
      __fullSql: "SELECT 1 FROM core.Activity",
      durationMs: 12,
      rowCount: 1,
    })

    expect(data["__fullSql"]).toBeUndefined()
    expect(typeof data["sqlLogId"]).toBe("number")
    expect(typeof data["sql"]).toBe("string")
    expect(data["sql"]).toContain("SELECT 1")
    expect(data["sqlLength"]).toBe(20)

    const row = getSyncSqlLog(data["sqlLogId"] as number)
    expect(row?.sql_text).toBe("SELECT 1 FROM core.Activity")
    expect(row?.plan_id).toBe("plan-1")
  })

  it("lists SQL rows by plan id in order", () => {
    recordSyncSqlLog({
      planId: "plan-a",
      eventType: "sync.preview.sql",
      label: "first",
      connection: "uat",
      sqlText: "SELECT 1",
    })
    recordSyncSqlLog({
      planId: "plan-a",
      eventType: "sync.execute.sql",
      label: "second",
      connection: "prod",
      sqlText: "MERGE ...",
    })

    expect(countSyncSqlLogByPlan("plan-a")).toBe(2)
    const rows = listSyncSqlLogByPlan("plan-a")
    expect(rows.map((r) => r.label)).toEqual(["first", "second"])
  })

  it("always persists EXEC preview for audit-check SQL even when only __fullSql is present", () => {
    const execSql =
      "EXEC core.uspAuditRunCheck @id=N'42', @objType=N'Contract', @action=N'syncOrNot', @schema=N'core'"
    const data = enrichSyncSqlEventData("sync.execute.sql", {
      planId: "plan-skip",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      durationMs: 415,
      rowCount: 0,
      __fullSql: execSql,
    })

    expect(data["sql"]).toBe(execSql)
    expect(data["sqlLength"]).toBe(execSql.length)
    expect(typeof data["sqlLogId"]).toBe("number")
    expect(getSyncSqlLog(data["sqlLogId"] as number)?.sql_text).toBe(execSql)
  })

  it("hydrates preview from sync_sql_log only via sqlLogId", () => {
    const execSql =
      "EXEC core.uspAuditRunCheck @id=N'7', @objType=N'Contract', @action=N'syncOrNot', @schema=N'core'"
    const sqlLogId = recordSyncSqlLog({
      planId: "plan-skip",
      eventType: "sync.execute.sql",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      sqlText: execSql,
      durationMs: 415,
      rowCount: 0,
    })

    const hydrated = hydratePersistedSqlEventData("sync.execute.sql", {
      planId: "plan-skip",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      durationMs: 415,
      rowCount: 0,
      sqlLogId,
    })

    expect(hydrated["sql"]).toBe(execSql)
    expect(hydrated["sqlLength"]).toBe(execSql.length)
  })

  it("does not guess sql_log rows at read time when sqlLogId is missing", () => {
    recordSyncSqlLog({
      planId: "plan-legacy",
      eventType: "sync.execute.sql",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      sqlText: "EXEC core.uspAuditRunCheck @id=5011",
      durationMs: 415,
      rowCount: 0,
    })

    const hydrated = hydratePersistedSqlEventData("sync.execute.sql", {
      planId: "plan-legacy",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      durationMs: 415,
      rowCount: 0,
    })

    expect(hydrated["sql"]).toBeUndefined()
    expect(hydrated["sqlLogId"]).toBeUndefined()
  })
})

describe("sync-sql-log backfill", () => {
  beforeEach(async () => {
    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
    _setDb(testDb)
    _migrate(testDb)
    // Migration 5 runs on boot; reset event_log to simulate pre-backfill legacy rows.
    testDb.exec("DELETE FROM event_log")
  })

  afterEach(() => {
    testDb.close()
  })

  it("writes sqlLogId onto event_log when exactly one sync_sql_log row matches", () => {
    const execSql =
      "EXEC core.uspAuditRunCheck @id=5011, @objType=N'Contract', @action=N'syncOrNot', @schema=N'core'"
    const sqlLogId = recordSyncSqlLog({
      planId: "plan-legacy",
      eventType: "sync.execute.sql",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      sqlText: execSql,
      durationMs: 415,
      rowCount: 0,
    })

    const eventId = saveEvent(
      "sync.execute.sql",
      {
        planId: "plan-legacy",
        label: "flowStep.auditCheck(auditCheck)",
        connection: "uat",
        durationMs: 415,
        rowCount: 0,
      },
      "2026-05-27T15:00:01.500Z",
    )

    const result = backfillSyncSqlEventLogLinks(testDb)
    expect(result).toEqual({ repaired: 1, skippedNoMatch: 0, skippedAmbiguous: 0 })

    const row = testDb.prepare("SELECT data FROM event_log WHERE id = ?").get(eventId) as {
      data: string
    }
    const data = JSON.parse(row.data) as Record<string, unknown>
    expect(data["sqlLogId"]).toBe(sqlLogId)
    expect(data["sql"]).toBe(execSql)
    expect(data["sqlLength"]).toBe(execSql.length)
  })

  it("skips ambiguous legacy rows instead of guessing", () => {
    const label = "flowStep.auditCheck(auditCheck)"
    recordSyncSqlLog({
      planId: "plan-legacy",
      eventType: "sync.execute.sql",
      label,
      connection: "uat",
      sqlText: "EXEC core.uspAuditRunCheck @id=1",
      durationMs: 415,
      rowCount: 0,
    })
    recordSyncSqlLog({
      planId: "plan-legacy",
      eventType: "sync.execute.sql",
      label,
      connection: "uat",
      sqlText: "EXEC core.uspAuditRunCheck @id=2",
      durationMs: 415,
      rowCount: 0,
    })

    saveEvent(
      "sync.execute.sql",
      {
        planId: "plan-legacy",
        label,
        connection: "uat",
        durationMs: 415,
        rowCount: 0,
      },
      "2026-05-27T15:00:01.500Z",
    )

    const result = backfillSyncSqlEventLogLinks(testDb)
    expect(result).toEqual({ repaired: 0, skippedNoMatch: 0, skippedAmbiguous: 1 })
  })
})
