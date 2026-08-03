import { describe, expect, it } from "vitest"
import {
  createPostgresMigrationRunner,
  kyselyPostgresDdlExecutor,
  type PostgresMigrationExecutor,
} from "./runner.js"

function fakeExecutor(): PostgresMigrationExecutor & { statements: string[] } {
  const statements: string[] = []
  const applied = new Map<number, { version: number; name: string; applied_at: string }>()
  return {
    statements,
    async query(sqlText) {
      statements.push(sqlText)
      if (sqlText.includes("_mia_schema_migrations") && sqlText.includes("CREATE TABLE")) {
        return { rows: [] }
      }
      if (sqlText.includes("SELECT version, name")) {
        return { rows: [...applied.values()] }
      }
      if (sqlText.includes("INSERT INTO _mia_schema_migrations")) {
        const match = /VALUES\s*\((\d+),\s*'([^']*)'\)/i.exec(sqlText)
        if (match) {
          const version = Number(match[1])
          applied.set(version, {
            version,
            name: match[2]!,
            applied_at: "2026-01-01T00:00:00",
          })
        }
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
}

describe("createPostgresMigrationRunner", () => {
  it("applies registry through memory_search_vector once", async () => {
    const ex = fakeExecutor()
    const runner = createPostgresMigrationRunner(ex)
    await runner.applyPending()
    await runner.applyPending()
    const list = await runner.list()
    expect(list.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(list[9]).toMatchObject({
      version: 10,
      name: "memory_search_vector",
      appliedAt: "2026-01-01T00:00:00",
    })
    const inserts = ex.statements.filter((s) => s.includes("INSERT INTO _mia_schema_migrations"))
    expect(inserts).toHaveLength(10)
    expect(ex.statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS memory_entries"))).toBe(true)
    expect(ex.statements.some((s) => s.includes("to_tsvector"))).toBe(true)
    expect(ex.statements.some((s) => s.includes("USING GIN"))).toBe(true)
  })

  it("exports a Kysely-backed DDL executor factory", () => {
    expect(typeof kyselyPostgresDdlExecutor).toBe("function")
  })
})
