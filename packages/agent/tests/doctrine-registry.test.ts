import { describe, expect, it } from "vitest"
import {
    DOCTRINE_BLOCK_BUDGET_BYTES,
    MSSQL_DOCTRINES,
    assembleDoctrineBlock,
    enforceDoctrines,
} from "../src/doctrine/index.js"

describe("doctrine registry", () => {
  it("every doctrine declares stable id and version", () => {
    const ids = new Set<string>()
    for (const d of MSSQL_DOCTRINES) {
      expect(d.id).toMatch(/^mssql\.[a-z-]+$/)
      expect(d.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(ids.has(d.id), `duplicate doctrine id ${d.id}`).toBe(false)
      ids.add(d.id)
    }
  })

  it("each doctrine summary fits its per-module byte budget", () => {
    for (const d of MSSQL_DOCTRINES) {
      const size = Buffer.byteLength(d.summary(), "utf8")
      expect(size, `${d.id} summary too large`).toBeLessThanOrEqual(d.summaryBudgetBytes)
    }
  })

  it("assembled doctrine block fits the total budget", () => {
    const block = assembleDoctrineBlock()
    const size = Buffer.byteLength(block, "utf8")
    expect(size).toBeLessThanOrEqual(DOCTRINE_BLOCK_BUDGET_BYTES)
  })

  it("no doctrine summary contains conditional 'if … exists' prose", () => {
    // Conditional rules belong in resolvedFacts (Phase 3), not in doctrine prose.
    // Allowlist: revenue-balances-policy carries the one explicit catalog-conditional
    // sentence as it documents the runtime decision the future planner will make.
    const allowlist = new Set(["mssql.revenue-balances-policy"])
    for (const d of MSSQL_DOCTRINES) {
      if (allowlist.has(d.id)) continue
      const text = d.summary().toLowerCase()
      expect(/\bif\b.+\bexists?\b/.test(text), `${d.id} summary has 'if … exists' prose`).toBe(false)
    }
  })

  it("enforceDoctrines flags an over-touched large object", () => {
    const sql = [
      "SELECT a.pkClient",
      "FROM publish.Revenue a",
      "JOIN publish.Revenue b ON b.pkClient = a.pkClient",
      "JOIN publish.Revenue c ON c.pkClient = a.pkClient",
      "WHERE a.pkMonth = 202501",
    ].join("\n")
    const diags = enforceDoctrines(sql)
    expect(diags.some((d) => d.code === "large_object_overused")).toBe(true)
  })

  it("enforceDoctrines flags an aggregate ↔ alias mismatch", () => {
    const sql = "SELECT SUM(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR FROM #x_a3f91c08 b WHERE b.pkMonth = 1"
    const diags = enforceDoctrines(sql)
    expect(diags.some((d) => d.code === "aggregate_semantic_mismatch")).toBe(true)
  })

  it("enforceDoctrines flags malformed temp suffix", () => {
    // 7-hex suffix instead of the required 8 — malformed length, all chars are hex.
    const sql = "CREATE TABLE #range_a3f91c0 (x int); SELECT * FROM #range_a3f91c0; DROP TABLE #range_a3f91c0;"
    const diags = enforceDoctrines(sql)
    expect(diags.some((d) => d.code === "temp_table_integrity")).toBe(true)
  })

  it("enforceDoctrines returns empty for a doctrine-clean query", () => {
    const sql = "SELECT pkClient FROM dim.Date WHERE [Year] = 2025"
    const diags = enforceDoctrines(sql)
    expect(diags).toEqual([])
  })
})
