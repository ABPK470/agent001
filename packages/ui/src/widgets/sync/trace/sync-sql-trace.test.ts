import { describe, expect, it } from "vitest"

import { hasSqlTraceContent, readSqlTraceFields } from "./sync-sql-trace"

describe("sync-sql-trace", () => {
  it("parses audit-check execute SQL events with sqlLogId", () => {
    const fields = readSqlTraceFields({
      planId: "plan-skip",
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      sql: "EXEC core.uspAuditRunCheck @id=N'42', @objType=N'Contract', @action=N'syncOrNot', @schema=N'core'",
      sqlLength: 95,
      sqlLogId: 17,
      rowCount: 1,
      durationMs: 415,
    })
    expect(fields).not.toBeNull()
    expect(fields!.sqlLogId).toBe(17)
    expect(hasSqlTraceContent(fields!)).toBe(true)
  })

  it("coerces string sqlLogId from persisted JSON", () => {
    const fields = readSqlTraceFields({
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      sqlLogId: "42",
      sql: "",
    })
    expect(fields?.sqlLogId).toBe(42)
    expect(hasSqlTraceContent(fields!)).toBe(true)
  })

  it("returns null when there is no label, sql, or sqlLogId", () => {
    expect(readSqlTraceFields({ connection: "uat" })).toBeNull()
  })

  it("does not treat label-only rows as viewable SQL", () => {
    const fields = readSqlTraceFields({
      label: "flowStep.auditCheck(auditCheck)",
      connection: "uat",
      rowCount: 0,
      durationMs: 415,
    })
    expect(fields).not.toBeNull()
    expect(hasSqlTraceContent(fields!)).toBe(false)
  })
})
