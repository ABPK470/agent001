import { describe, expect, it } from "vitest"
import {
  createMssqlMigrationRunner,
  kyselyPlatformDdlExecutor,
  type MssqlQueryExecutor,
} from "./runner.js"

function fakeExecutor(): MssqlQueryExecutor & { statements: string[] } {
  const statements: string[] = []
  const applied = new Map<number, { version: number; name: string; applied_at: string }>()
  return {
    statements,
    async query(sqlText) {
      statements.push(sqlText)
      if (sqlText.includes("_mia_schema_migrations") && sqlText.includes("CREATE TABLE")) {
        return { recordset: [] }
      }
      if (sqlText.includes("SELECT version, name")) {
        return {
          recordset: [...applied.values()],
        }
      }
      if (sqlText.includes("INSERT INTO dbo._mia_schema_migrations")) {
        const match = /VALUES\s*\((\d+),\s*N'([^']*)'\)/i.exec(sqlText)
        if (match) {
          const version = Number(match[1])
          applied.set(version, {
            version,
            name: match[2]!,
            applied_at: "2026-01-01T00:00:00",
          })
        }
        return { recordset: [] }
      }
      // pilot DDL body
      return { recordset: [] }
    },
  }
}

describe("createMssqlMigrationRunner", () => {
  it("applies pilot migration once and lists it as applied", async () => {
    const ex = fakeExecutor()
    const runner = createMssqlMigrationRunner(ex)
    await runner.applyPending()
    await runner.applyPending()
    const list = await runner.list()
    expect(list.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(list[10]).toMatchObject({
      version: 11,
      name: "drop_browser_tables",
      appliedAt: "2026-01-01T00:00:00",
    })
    const inserts = ex.statements.filter((s) => s.includes("INSERT INTO dbo._mia_schema_migrations"))
    expect(inserts).toHaveLength(11)
    expect(ex.statements.some((s) => s.includes("CREATE TABLE dbo.eval_dataset_entries"))).toBe(true)
    expect(ex.statements.some((s) => s.includes("CREATE TABLE dbo.memory_entries"))).toBe(true)
    expect(ex.statements.some((s) => s.includes("DROP TABLE dbo.browser_contexts"))).toBe(true)
    expect(ex.statements.some((s) => s.includes("CREATE TABLE dbo.browser_contexts"))).toBe(false)
  })

  it("exports a Kysely-backed DDL executor factory", () => {
    expect(typeof kyselyPlatformDdlExecutor).toBe("function")
  })
})
