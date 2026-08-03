import { describe, expect, it } from "vitest"
import { mssqlDeleteBatchSql } from "./delete.js"
import { mssqlUpsertBatchSql } from "./upsert.js"

describe("mssqlUpsertBatchSql", () => {
  it("builds temp table + MERGE with identity insert", () => {
    const sql = mssqlUpsertBatchSql({
      table: "core.Pipeline",
      pkColumns: ["pipelineId"],
      tempCols: ["pipelineId", "name"],
      updateCols: ["name"],
      identityCol: "pipelineId",
      useIdentityInsert: true,
      allowUpdate: true,
      rows: [{ pipelineId: 1, name: "a" }],
      onInsertStamps: { syncDate: "GETUTCDATE()" },
      onUpdateStamps: { syncDate: "GETUTCDATE()" },
    })
    expect(sql).toContain("INTO #syncSrc")
    expect(sql).toContain("SET IDENTITY_INSERT [core].[Pipeline] ON")
    expect(sql).toContain("MERGE [core].[Pipeline] AS T")
    expect(sql).toContain("WHEN MATCHED THEN UPDATE SET")
    expect(sql).toContain("DROP TABLE #syncSrc")
  })
})

describe("mssqlDeleteBatchSql", () => {
  it("builds temp PK table + DELETE join", () => {
    const sql = mssqlDeleteBatchSql({
      table: "core.Pipeline",
      pkColumns: ["pipelineId"],
      rows: [{ pipelineId: 9 }],
    })
    expect(sql).toContain("INTO #syncDelPk")
    expect(sql).toContain("DELETE T FROM [core].[Pipeline] T")
    expect(sql).toContain("DROP TABLE #syncDelPk")
  })
})
