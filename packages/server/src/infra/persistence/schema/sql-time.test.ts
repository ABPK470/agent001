import { afterEach, describe, expect, it } from "vitest"
import { Kysely, SqliteDialect } from "kysely"
import Database from "better-sqlite3"
import {
  bindPlatformDb,
  getPlatformDbKind,
  resetPlatformDbForTests,
} from "./kysely.js"
import { platformNow, platformNowMinusSeconds } from "./sql-time.js"
import type { PlatformDatabase } from "./tables.js"

afterEach(() => {
  resetPlatformDbForTests()
})

describe("platformNow", () => {
  it("defaults to sqlite datetime('now')", async () => {
    expect(getPlatformDbKind()).toBe("sqlite")
    const mem = new Database(":memory:")
    const db = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    const compiled = db.selectNoFrom(platformNow().as("now")).compile()
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
    // Fragment chooses by getPlatformDbKind(), not by the query compiler dialect.
    const compiled = fake.selectNoFrom(platformNow().as("now")).compile()
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
