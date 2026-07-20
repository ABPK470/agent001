import { describe, expect, it } from "vitest"
import { quoteSqlLiteral } from "../src/sql-literals.js"

describe("quoteSqlLiteral", () => {
  it("handles nullish, numbers, bools", () => {
    expect(quoteSqlLiteral(null)).toBe("NULL")
    expect(quoteSqlLiteral(undefined)).toBe("NULL")
    expect(quoteSqlLiteral(42)).toBe("42")
    expect(quoteSqlLiteral(true)).toBe("1")
    expect(quoteSqlLiteral(false)).toBe("0")
  })

  it("emits ISO-8601 for Date — not locale String(date)", () => {
    const d = new Date("2024-06-15T12:34:56.789Z")
    expect(quoteSqlLiteral(d)).toBe("'2024-06-15T12:34:56.789Z'")
    // Locale dump is what broke MSSQL datetime inserts.
    expect(quoteSqlLiteral(d)).not.toContain("GMT")
  })

  it("escapes strings as NVARCHAR literals", () => {
    expect(quoteSqlLiteral("a'b")).toBe("N'a''b'")
  })

  it("encodes buffers as hex", () => {
    expect(quoteSqlLiteral(Buffer.from([0xde, 0xad]))).toBe("0xdead")
  })
})
