/**
 * Tests for decorateMssqlError — turns terse SQL Server errors into
 * actionable recovery hints so the next agent turn knows what to fix.
 */

import { describe, expect, it } from "vitest"
import { decorateMssqlError } from "../src/tools/mssql/error-hints.js"

describe("decorateMssqlError", () => {
  it("annotates Invalid column name with explore_mssql_schema guidance", () => {
    const out = decorateMssqlError("Invalid column name 'Name'.")
    expect(out).toMatch(/Invalid column name 'Name'/)
    expect(out).toMatch(/explore_mssql_schema/)
    expect(out).toMatch(/STOP guessing/i)
  })

  it("annotates Invalid object name with search_catalog guidance", () => {
    const out = decorateMssqlError("Invalid object name 'publish.Reveune'.")
    expect(out).toMatch(/search_catalog/)
    expect(out).toMatch(/Reveune/)
  })

  it("annotates MIN(bit) with CAST guidance", () => {
    const out = decorateMssqlError("Operand data type bit is invalid for min operator.")
    expect(out).toMatch(/CAST\(col AS int\)/)
    expect(out).toMatch(/MIN/)
  })

  it("annotates SUM(bit)", () => {
    const out = decorateMssqlError("Operand data type bit is invalid for sum operator.")
    expect(out).toMatch(/SUM\(CAST\(col AS int\)\)/)
  })

  it("annotates QUALIFY with ROW_NUMBER guidance", () => {
    const out = decorateMssqlError("Incorrect syntax near 'QUALIFY'.")
    expect(out).toMatch(/ROW_NUMBER/)
    expect(out).toMatch(/Snowflake|BigQuery/i)
  })

  it("annotates LIMIT with TOP / OFFSET-FETCH guidance", () => {
    const out = decorateMssqlError("Incorrect syntax near 'LIMIT'.")
    expect(out).toMatch(/TOP n/)
    expect(out).toMatch(/OFFSET/)
  })

  it("annotates ILIKE with LIKE guidance", () => {
    const out = decorateMssqlError("Incorrect syntax near 'ILIKE'.")
    expect(out).toMatch(/LIKE/)
    expect(out).toMatch(/Postgres/i)
  })

  it("annotates timeout with micro-ETL guidance", () => {
    const out = decorateMssqlError("Request failed: query timeout expired")
    expect(out).toMatch(/#scope/)
    expect(out).toMatch(/micro-ETL/i)
  })

  it("passes through unknown errors unchanged", () => {
    const orig = "Some completely unrelated database error message."
    expect(decorateMssqlError(orig)).toBe(orig)
  })

  it("only appends one hint (first match wins)", () => {
    // both 'Invalid column name' and 'QUALIFY' would match — the column-name
    // hint is listed first, so that wins.
    const out = decorateMssqlError("Invalid column name 'QUALIFY'.")
    expect(out).toMatch(/explore_mssql_schema/)
    expect(out).not.toMatch(/ROW_NUMBER/)
  })
})
