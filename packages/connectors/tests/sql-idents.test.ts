import { describe, expect, it } from "vitest"
import {
  quoteMssqlIdent,
  quoteMssqlTable,
  quoteOracleTable,
  quotePgIdent,
  quotePgTable,
  splitOracleTable,
} from "../src/sql-idents.js"

describe("quoteMssqlTable", () => {
  it("splits schema.table from the live catalog picker", () => {
    expect(quoteMssqlTable("dbo.Items")).toBe("[dbo].[Items]")
  })

  it("quotes a bare table name", () => {
    expect(quoteMssqlTable("Items")).toBe("[Items]")
  })

  it("escapes closing brackets inside a part", () => {
    expect(quoteMssqlIdent("a]b")).toBe("[a]]b]")
  })
})

describe("quotePgTable", () => {
  it("splits schema.table for Postgres / Databricks", () => {
    expect(quotePgTable("public.items")).toBe('"public"."items"')
  })

  it("escapes embedded double quotes", () => {
    expect(quotePgIdent('a"b')).toBe('"a""b"')
  })
})

describe("oracle idents", () => {
  it("quotes OWNER.TABLE like Postgres delimited identifiers", () => {
    expect(quoteOracleTable("HR.EMPLOYEES")).toBe('"HR"."EMPLOYEES"')
  })

  it("splits owner.table for dictionary lookups", () => {
    expect(splitOracleTable("hr.employees")).toEqual({ owner: "HR", table: "EMPLOYEES" })
    expect(splitOracleTable("EMPLOYEES")).toEqual({ owner: null, table: "EMPLOYEES" })
  })
})
