import { describe, expect, it } from "vitest"
import {
  quoteMssqlIdent,
  quoteMssqlTable,
  quotePgIdent,
  quotePgTable,
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
