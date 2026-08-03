import { describe, expect, it } from "vitest"
import { isTransientSqlError } from "../src/errors.js"

describe("isTransientSqlError", () => {
  it("matches known codes and messages", () => {
    expect(isTransientSqlError(Object.assign(new Error("x"), { code: "ETIMEOUT" }))).toBe(true)
    expect(isTransientSqlError(new Error("Connection is closed."))).toBe(true)
    expect(isTransientSqlError(new Error("syntax error near MERGE"))).toBe(false)
    expect(isTransientSqlError("not an error")).toBe(false)
  })
})
