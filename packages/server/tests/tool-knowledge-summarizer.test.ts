/**
 * Tests for the tool_knowledge → inline-summary compactor.
 *
 * Fixtures mirror the actual emitter formats — verified against
 * packages/agent/src/tools/{mssql/tools.ts, mssql-profiler.ts,
 * mssql-inspector/tool.ts, mssql-relationships/index.ts}.
 */

import { describe, expect, it } from "vitest"
import { summarizeCachedPayload } from "../src/memory/tool-knowledge-summarizer.js"

describe("summarizeCachedPayload — explore_mssql_schema", () => {
  it("extracts col(type) pairs and PK / FK markers from a pipe-table payload", () => {
    const payload = [
      "Columns for publish.Revenue:",
      "COLUMN_NAME | DATA_TYPE | IS_NULLABLE | IS_PK | FK_REFERENCE",
      "------------+-----------+-------------+-------+-------------",
      "Id          | int       | NO          | 1     | NULL",
      "CustomerId  | int       | NO          | 0     | dim.Customer.Id",
      "Amount      | decimal   | YES         | 0     | NULL",
    ].join("\n")
    const out = summarizeCachedPayload("explore_mssql_schema", "columns", payload)
    expect(out).toContain("Id(int [PK])")
    expect(out).toContain("CustomerId(int [FK→dim.Customer.Id])")
    expect(out).toContain("Amount(decimal)")
    expect(out.startsWith("cols:")).toBe(true)
  })

  it("truncates with ellipsis when the column count exceeds the per-section cap", () => {
    const rows = ["COLUMN_NAME | DATA_TYPE", "------------+----------"]
    for (let i = 0; i < 30; i++) rows.push(`Col${i} | int`)
    const out = summarizeCachedPayload("explore_mssql_schema", "columns", `Columns for x.y:\n${rows.join("\n")}`)
    expect(out).toMatch(/, …$/)
  })

  it("falls back to [raw] when the header isn't present", () => {
    const out = summarizeCachedPayload("explore_mssql_schema", "columns", "Just a freeform note about something")
    expect(out.startsWith("[raw]")).toBe(true)
  })
})

describe("summarizeCachedPayload — profile_data fast", () => {
  it("extracts rows, type, index count, and column list", () => {
    const payload = [
      "Profile (FAST mode) for publish.Revenue:",
      "  Type: TABLE",
      "  Total rows: 1,234,567  (from sys.dm_db_partition_stats — no scan)",
      "",
      "Indexes (3):",
      "  PK_Revenue [CLUSTERED]: Id",
      "  IX_RevenueDate [NONCLUSTERED]: Date",
      "  IX_CustomerId [NONCLUSTERED]: CustomerId",
      "",
      "Columns (14):",
      "  Id (int, NOT NULL)",
      "  CustomerId (int, NOT NULL)",
      "  Amount (decimal, nullable)",
      "  Date (datetime, NOT NULL)",
      "",
      "Sample rows (5):",
      "  ...",
    ].join("\n")
    const out = summarizeCachedPayload("profile_data", "fast", payload)
    expect(out).toContain("rows=1,234,567")
    expect(out).toContain("type=table")
    expect(out).toContain("indexes=3")
    expect(out).toContain("cols(14)")
    expect(out).toContain("Id(int)")
    expect(out).toContain("Amount(decimal)")
    expect(out.startsWith("fast")).toBe(true)
  })

  it("survives a payload missing the indexes section", () => {
    const payload = [
      "Profile (FAST mode) for x.y:",
      "  Type: VIEW",
      "  Total rows: (not available for views in fast mode; use a filtered query_mssql to count)",
      "",
      "Columns (2):",
      "  A (int, NOT NULL)",
      "  B (varchar, nullable)",
    ].join("\n")
    const out = summarizeCachedPayload("profile_data", "fast", payload)
    expect(out).toContain("type=view")
    expect(out).toContain("cols(2)")
    expect(out).not.toContain("indexes=")
  })
})

describe("summarizeCachedPayload — profile_data deep", () => {
  it("appends notable distinct / null highlights to the fast summary", () => {
    const payload = [
      "Profile (DEEP mode) for publish.Revenue:",
      "  Type: TABLE",
      "  Total rows: 1,000,000",
      "",
      "Columns (3):",
      "  Id (int, NOT NULL)",
      "    Distinct: 950,000 (95.0%)",
      "    Nulls: 0 (0.0%)",
      "  Status (varchar, nullable)",
      "    Distinct: 5 (0.0%)",
      "    Nulls: 200,000 (20.0%)",
      "  Amount (decimal, nullable)",
      "    Distinct: 80,000 (8.0%)",
      "    Nulls: 0 (0.0%)",
    ].join("\n")
    const out = summarizeCachedPayload("profile_data", "deep", payload)
    expect(out.startsWith("deep")).toBe(true)
    expect(out).toContain("Id distinct=95%")
    expect(out).toContain("Status nulls=20%")
  })
})

describe("summarizeCachedPayload — inspect_definition", () => {
  it("extracts type, col count, PK, FK and index counts", () => {
    const payload = [
      "CREATE TABLE publish.Revenue (",
      "  Id INT NOT NULL,",
      "  ...",
      ")",
      "",
      "Columns (14)",
      "Primary key: Id",
      "Foreign keys (2)",
      "Indexes (3)",
    ].join("\n")
    const out = summarizeCachedPayload("inspect_definition", "definition", payload)
    expect(out).toContain("TABLE")
    expect(out).toContain("14 cols")
    expect(out).toContain("PK=Id")
    expect(out).toContain("FKs=2")
    expect(out).toContain("indexes=3")
  })

  it("falls back to [raw] when no structural markers are present", () => {
    const out = summarizeCachedPayload("inspect_definition", "definition", "Some opaque DDL blob")
    expect(out.startsWith("[raw]")).toBe(true)
  })
})

describe("summarizeCachedPayload — discover_relationships", () => {
  it("extracts arrow lines and counts them", () => {
    const payload = [
      "Foreign keys for publish.Revenue:",
      "  publish.Revenue.CustomerId → dim.Customer.Id",
      "  publish.Revenue.ProductId  → dim.Product.Id",
      "  (some prose)",
      "  publish.Revenue.BranchId   -> dim.Branch.Id",
    ].join("\n")
    const out = summarizeCachedPayload("discover_relationships", "fk", payload)
    expect(out).toMatch(/^rels\(3\):/)
    expect(out).toContain("publish.Revenue.CustomerId→dim.Customer.Id")
    expect(out).toContain("publish.Revenue.BranchId→dim.Branch.Id")
  })
})

describe("summarizeCachedPayload — guarantees", () => {
  it("respects the per-summary char cap", () => {
    const longPayload = "x ".repeat(5000)
    const out = summarizeCachedPayload("inspect_definition", "definition", longPayload, { maxChars: 80 })
    expect(out.length).toBeLessThanOrEqual(80)
  })

  it("does not throw on empty payload", () => {
    expect(() => summarizeCachedPayload("profile_data", "fast", "")).not.toThrow()
    expect(() => summarizeCachedPayload("explore_mssql_schema", "columns", "")).not.toThrow()
    expect(() => summarizeCachedPayload("inspect_definition", "definition", "")).not.toThrow()
    expect(() => summarizeCachedPayload("discover_relationships", "fk", "")).not.toThrow()
  })
})
