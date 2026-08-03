import { afterEach, describe, expect, it } from "vitest"
import { Kysely, SqliteDialect } from "kysely"
import Database from "better-sqlite3"
import {
  bindPlatformDb,
  getPlatformDbKind,
  resetPlatformDbForTests,
} from "./kysely.js"
import { injectMssqlOutputInsertedId, runGetAsync } from "./execute-async.js"
import type { PlatformDatabase } from "./tables.js"

afterEach(() => {
  resetPlatformDbForTests()
})

describe("execute-async", () => {
  it("defaults to sqlite before any bind", () => {
    expect(getPlatformDbKind()).toBe("sqlite")
  })

  it("injects OUTPUT INSERTED.id into mssql-shaped inserts", () => {
    const out = injectMssqlOutputInsertedId(
      `insert into "notification_log" ("route_id", "event_type") values (@1, @2)`,
    )
    expect(out).toBe(
      `insert into "notification_log" ("route_id", "event_type") OUTPUT INSERTED.id values (@1, @2)`,
    )
  })

  it("refuses inject on non-insert SQL", () => {
    expect(() => injectMssqlOutputInsertedId("select 1")).toThrow(/cannot inject/)
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
    expect(getPlatformDbKind()).toBe("mssql")
    await fake.destroy()
    mem.close()
  })
})
