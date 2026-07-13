import { describe, expect, it } from "vitest"
import { tokenizeSql } from "./sql-highlight"

const FETCH_COLUMNS = `SELECT
    c.name              AS columnName,
    c.is_computed       AS isComputed,
    c.is_identity       AS isIdentity,
    LOWER(ty.name)      AS systemType
FROM sys.columns c
JOIN sys.objects o  ON o.object_id = c.object_id
JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
WHERE o.[type] = 'U'
  AND o.name = 'Contract'
  AND OBJECT_SCHEMA_NAME(c.object_id) = 'core'
ORDER BY c.column_id`

describe("tokenizeSql", () => {
  it("tokenises string literals without swallowing following identifiers", () => {
    const toks = tokenizeSql(FETCH_COLUMNS)
    expect(toks.some((t) => t.k === "str" && t.t === "'U'")).toBe(true)
    expect(toks.some((t) => t.k === "str" && t.t === "'Contract'")).toBe(true)
    expect(toks.some((t) => t.k === "str" && t.t === "'core'")).toBe(true)
    expect(toks.some((t) => t.k === "str" && t.t.includes("o.name"))).toBe(false)
  })

  it("keeps lowercase object_id as identifier, not keyword", () => {
    const toks = tokenizeSql("WHERE o.object_id = c.object_id")
    expect(toks.filter((t) => t.t === "object_id").every((t) => t.k === "ident")).toBe(true)
  })

  it("highlights OBJECT_SCHEMA_NAME when uppercase", () => {
    const toks = tokenizeSql("OBJECT_SCHEMA_NAME(c.object_id)")
    const fn = toks.find((t) => t.t === "OBJECT_SCHEMA_NAME")
    expect(fn?.k).toBe("kw")
  })

  it("tokenises bracket identifiers as one piece", () => {
    const toks = tokenizeSql("WHERE o.[type] = 'U'")
    expect(toks.some((t) => t.t === "[type]")).toBe(true)
  })

  it("handles doubled single-quotes inside strings", () => {
    const toks = tokenizeSql("SELECT 'O''Brien' AS name")
    expect(toks.some((t) => t.k === "str" && t.t === "'O''Brien'")).toBe(true)
  })
})
