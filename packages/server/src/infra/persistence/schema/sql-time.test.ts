import { afterEach, describe, expect, it } from "vitest"
import { Kysely, SqliteDialect } from "kysely"
import Database from "better-sqlite3"
import {
  bindPlatformDb,
  getPlatformDbKind,
  resetPlatformDbForTests,
} from "./kysely.js"
import { platformNow, platformNowMinusSeconds, platformNowSql } from "./sql-time.js"
import type { PlatformDatabase } from "./tables.js"

afterEach(() => {
  resetPlatformDbForTests()
})

describe("platformNow", () => {
  it("returns an ISO UTC string bind value", () => {
    expect(getPlatformDbKind()).toBe("sqlite")
    expect(platformNow()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("emits sqlite datetime('now') as SQL fragment", async () => {
    const mem = new Database(":memory:")
    const db = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    const compiled = db.selectNoFrom(platformNowSql().as("now")).compile()
    expect(compiled.sql).toContain("datetime('now')")
    await db.destroy()
    mem.close()
  })

  it("emits SYSUTCDATETIME when mssql is bound", async () => {
    const mem = new Database(":memory:")
    const fake = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    bindPlatformDb("mssql", fake)
    const compiled = fake.selectNoFrom(platformNowSql().as("now")).compile()
    expect(compiled.sql).toContain("SYSUTCDATETIME()")
    const windowed = fake.selectNoFrom(platformNowMinusSeconds(3600).as("cut")).compile()
    expect(windowed.sql).toMatch(/DATEADD\s*\(\s*second/i)
    await fake.destroy()
    mem.close()
  })

  it("emits sqlite modifier for activity windows by default", async () => {
    const mem = new Database(":memory:")
    const db = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    const compiled = db.selectNoFrom(platformNowMinusSeconds(86_400).as("cut")).compile()
    expect(compiled.sql).toContain("datetime('now'")
    expect(compiled.parameters).toContain("-86400 seconds")
    await db.destroy()
    mem.close()
  })
})
