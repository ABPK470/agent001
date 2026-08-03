import { describe, expect, it } from "vitest"
import { createMssqlPlatformKysely } from "./kysely.js"

describe("createMssqlPlatformKysely", () => {
  it("compiles with @n placeholders (MssqlDialect)", () => {
    const db = createMssqlPlatformKysely({
      server: "localhost",
      port: 1433,
      database: "mia",
      user: "sa",
      password: "x",
      encrypt: true,
      trustServerCertificate: true,
    })
    const compiled = db
      .selectFrom("users")
      .select("upn")
      .where("upn", "=", "a@b.c")
      .compile()
    expect(compiled.sql).toMatch(/@\d/)
    expect(compiled.parameters).toEqual(["a@b.c"])
  })
})
