import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  countSyncSqlLogByPlan,
  enrichSyncSqlEventData,
  getSyncSqlLog,
  listSyncSqlLogByPlan,
  recordSyncSqlLog,
} from "../src/platform/persistence/db/sync-sql-log.js"

let testDb: Database.Database

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
})
