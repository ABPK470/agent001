import { describe, expect, it } from "vitest"

import { createPostgresWarehouseDialect } from "./index.js"

describe("createPostgresWarehouseDialect upsert/delete", () => {
  const dialect = createPostgresWarehouseDialect()

  it("builds ON CONFLICT upsert without mssql MERGE", () => {
    const sql = dialect.upsertBatchSql({
      table: "core.Contract",
      pkColumns: ["contractId"],
      tempCols: ["contractId", "name"],
      updateCols: ["name"],
      identityCol: null,
      useIdentityInsert: false,
      allowUpdate: true,
      rows: [{ contractId: 1, name: "a" }],
      onInsertStamps: {},
      onUpdateStamps: {},
    })
    expect(sql).toContain("ON CONFLICT")
    expect(sql).toContain("DO UPDATE")
    expect(sql).not.toContain("MERGE")
    expect(sql).not.toContain("#syncSrc")
  })

  it("builds DELETE USING values", () => {
    const sql = dialect.deleteBatchSql({
      table: "core.Contract",
      pkColumns: ["contractId"],
      rows: [{ contractId: 1 }],
    })
    expect(sql).toContain("DELETE FROM")
    expect(sql).toContain("USING (VALUES")
  })

  it("gates mssql_procedure and constraint_relax", () => {
    expect(dialect.supports("mssql_procedure")).toBe(false)
    expect(dialect.supports("constraint_relax")).toBe(false)
    expect(dialect.supports("temp_tables")).toBe(true)
    expect(dialect.readFromHintSql()).toBe("")
    expect(dialect.utcNowExpr()).toContain("AT TIME ZONE")
  })
})
