import { afterEach, describe, expect, it } from "vitest"
import { Kysely, SqliteDialect } from "kysely"
import Database from "better-sqlite3"
import {
  bindPlatformDb,
  resetPlatformDbForTests,
} from "./kysely.js"
import { jsonPathText } from "./json-path.js"
import type { PlatformDatabase } from "./tables.js"

afterEach(() => {
  resetPlatformDbForTests()
})

describe("jsonPathText", () => {
  it("emits json_extract on sqlite (default kind)", () => {
    resetPlatformDbForTests()
    const mem = new Database(":memory:")
    const db = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    const compiled = jsonPathText("data", "$.opId").compile(db)
    expect(compiled.sql).toMatch(/json_extract/i)
    expect(compiled.sql).not.toMatch(/JSON_VALUE/i)
    void db.destroy()
    mem.close()
  })

  it("emits JSON_VALUE when mssql is bound", () => {
    const mem = new Database(":memory:")
    const db = new Kysely<PlatformDatabase>({
      dialect: new SqliteDialect({ database: mem }),
    })
    bindPlatformDb("mssql", db)
    const compiled = jsonPathText("data", "$.opId").compile(db)
    expect(compiled.sql).toMatch(/JSON_VALUE/i)
    void db.destroy()
    mem.close()
  })
})
