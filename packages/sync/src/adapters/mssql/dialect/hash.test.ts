import { describe, expect, it } from "vitest"
import { mssqlHashExpr, mssqlHashSelectSql } from "./hash.js"
import { MSSQL_DETERMINISTIC_SESSION_PREFIX } from "./session.js"

describe("mssqlHashExpr", () => {
  it("uses culture-invariant CONVERT for datetime", () => {
    expect(mssqlHashExpr({ name: "updatedAt", systemType: "datetime2" })).toBe(
      "CONVERT(NVARCHAR(33), [updatedAt], 126)",
    )
  })

  it("falls back to CAST for nvarchar-like types", () => {
    expect(mssqlHashExpr({ name: "name", systemType: "nvarchar" })).toBe(
      "CAST([name] AS NVARCHAR(MAX))",
    )
  })
})

describe("mssqlHashSelectSql", () => {
  it("pins session prefix and HASHBYTES fingerprint", () => {
    const sql = mssqlHashSelectSql({
      table: "core.Pipeline",
      pkColumns: ["pipelineId"],
      hashColumns: [{ name: "name", systemType: "nvarchar" }],
      whereSql: "1 = 1",
    })
    expect(sql.startsWith(MSSQL_DETERMINISTIC_SESSION_PREFIX)).toBe(true)
    expect(sql).toContain("HASHBYTES('SHA2_256'")
    expect(sql).toContain("FROM [core].[Pipeline] WHERE 1 = 1")
  })
})
