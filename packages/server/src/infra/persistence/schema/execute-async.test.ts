import { afterEach, describe, expect, it } from "vitest"
import { Kysely, SqliteDialect } from "kysely"
import Database from "better-sqlite3"
import {
  bindPlatformDb,
  getPlatformDbKind,
  resetPlatformDbForTests,
} from "./kysely.js"
import { runGetAsync, runInsertIdAsync } from "./execute-async.js"
import type { PlatformDatabase } from "./tables.js"

afterEach(() => {
  resetPlatformDbForTests()
})

describe("execute-async", () => {
  it("defaults to sqlite before any bind", () => {
    expect(getPlatformDbKind()).toBe("sqlite")
  })

  it("refuses runInsertIdAsync when mssql is bound", async () => {
    const mem = new Database(":memory:")
    const fake = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    bindPlatformDb("mssql", fake)
    expect(getPlatformDbKind()).toBe("mssql")
    await expect(
      runInsertIdAsync({ sql: "select 1", parameters: [] }),
    ).rejects.toThrow(/sqlite-only/)
    await fake.destroy()
    mem.close()
  })

  it("runGetAsync uses executeQuery when non-sqlite is bound", async () => {
    const mem = new Database(":memory:")
    mem.exec(`
      CREATE TABLE users (
        upn TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT NOT NULL,
        is_admin INT NOT NULL,
        password_hash TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      )
    `)
    const fake = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    bindPlatformDb("mssql", fake)
    const compiled = fake
      .selectFrom("users")
      .selectAll()
      .where("upn", "=", "missing")
      .compile()
    const row = await runGetAsync(compiled)
    expect(row).toBeUndefined()
    await fake.destroy()
    mem.close()
  })
})
