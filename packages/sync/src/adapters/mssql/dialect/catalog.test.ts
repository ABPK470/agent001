import { describe, expect, it } from "vitest"

import { createMssqlWarehouseDialect } from "./index.js"

describe("mssql catalog dialect SQL", () => {
  const dialect = createMssqlWarehouseDialect()

  it("pins hash column meta + FK + trigger probes", () => {
    expect(dialect.hashColumnsMetaSql("core.Contract")).toContain("sys.columns")
    expect(dialect.inboundForeignKeysSql("core.Contract")).toContain("sys.foreign_keys")
    expect(dialect.tableHasTriggersSql("core.Contract")).toContain("sys.triggers")
    expect(dialect.readFromHintSql()).toBe(" WITH (NOLOCK)")
  })

  it("pins constraint relax SQL", () => {
    expect(dialect.disableConstraintsSql("core.Child")).toContain("NOCHECK CONSTRAINT ALL")
    expect(dialect.enableConstraintsSql("core.Child")).toContain("CHECK CONSTRAINT ALL")
  })
})
