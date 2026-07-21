/**
 * Aggregate-semantic guard — locks down the SUM(Average*) / AVG(Sum*) class
 * of correctness regressions so they cannot slip past the tool layer.
 *
 * Two tiers:
 *   • BLOCK  — function family ≠ alias family ⇒ refuse to execute.
 *   • WARN   — SUM applied to a pre-aggregated column name ⇒ surface a
 *              warning banner in the result text the LLM reads.
 *
 * If you find yourself relaxing one of these tests, first ask: am I
 * weakening the structural defence, or fixing a real false positive?
 * In the latter case add the new clean case here as well.
 */
import { describe, expect, it } from "vitest"
import { AggregateSeverity } from "../src/domain/enums/sql-guard.js"
import {
  findAggregateSemanticIssues,
  getQueryWarnings,
  validateQuery
} from "../src/tools/database/mssql/validation.js"

describe("aggregate-semantic guard — BLOCK (alias-function mismatch)", () => {
  it("blocks SUM(...) AS Avg…", () => {
    const q = "SELECT SUM(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR FROM #scope b"
    const issues = findAggregateSemanticIssues(q)
    expect(issues.some((i) => i.severity === AggregateSeverity.Block)).toBe(true)
    expect(validateQuery(q)).toMatch(/aggregate-semantic mismatch/i)
  })

  it("blocks AVG(...) AS Total…", () => {
    const q = "SELECT AVG(t.RevenueZAR) AS TotalRevenueZAR FROM publish.Revenue t WHERE pkMonth = 202501"
    const issues = findAggregateSemanticIssues(q)
    expect(issues.some((i) => i.severity === AggregateSeverity.Block)).toBe(true)
  })

  it("blocks lowercase / mixed-case (sum...as avg…)", () => {
    const q = "select sum(x) as average_thing from #t"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Block)).toBe(true)
  })

  it("blocks alias mismatch with table-qualified column", () => {
    const q = "SELECT SUM(t.x) AS MeanX FROM #t t"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Block)).toBe(true)
  })

  it("blocks MIN(...) AS Max…", () => {
    const q = "SELECT MIN(p.pkDate) AS MaxDate FROM #p p"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Block)).toBe(true)
  })

  it("does NOT block COUNT(...) AS Total… (legitimate phrasing)", () => {
    const q = "SELECT COUNT(*) AS TotalRows FROM #t"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Block)).toBe(false)
  })
})

describe("aggregate-semantic guard — WARN (suspect column name)", () => {
  it("warns on SUM(AverageX) without explicit sum-prefixed alias", () => {
    const q = "SELECT SUM(b.AverageCreditBalanceZARMTD) AS CreditBalZAR FROM #scope b"
    const issues = findAggregateSemanticIssues(q)
    expect(issues.some((i) => i.severity === AggregateSeverity.Warn)).toBe(true)
    expect(validateQuery(q)).toBeNull() // does NOT block
    expect(getQueryWarnings(q)).toMatch(/CORRECTNESS WARNING/)
  })

  it("warns on SUM(SpotBalance) — point-in-time semantics (alias is neutral)", () => {
    // Alias "PointInTimeBalance" has no sum/avg/max/min prefix, so we hit WARN
    // (not BLOCK). With a Spot/Latest-prefixed alias the BLOCK rule fires first.
    const q = "SELECT SUM(b.SpotBalanceZAR) AS PointInTimeBalance FROM #scope b"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Warn)).toBe(true)
  })

  it("warns on SUM(EOMBalance)", () => {
    const q = "SELECT SUM(b.EOMBalance) AS BalanceZAR FROM #scope b"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Warn)).toBe(true)
  })

  it("suppresses warn when alias explicitly acknowledges the sum (SumOfMonthlyAvgs)", () => {
    const q = "SELECT SUM(b.AverageCreditBalanceZARMTD) AS SumOfMonthlyAvgs FROM #scope b"
    expect(findAggregateSemanticIssues(q).filter((i) => i.severity === AggregateSeverity.Warn).length).toBe(0)
  })

  it("suppresses warn when alias is TotalAvgFoo", () => {
    const q = "SELECT SUM(b.AverageX) AS TotalAvgX FROM #t b"
    expect(findAggregateSemanticIssues(q).filter((i) => i.severity === AggregateSeverity.Warn).length).toBe(0)
  })

  it("warns through ISNULL wrapper", () => {
    const q = "SELECT SUM(ISNULL(b.AverageCreditBalanceZARMTD, 0)) AS CreditBalZAR FROM #scope b"
    expect(findAggregateSemanticIssues(q).some((i) => i.severity === AggregateSeverity.Warn)).toBe(true)
  })
})

describe("aggregate-semantic guard — clean queries pass", () => {
  it("AVG(AverageX) AS AvgX is clean", () => {
    const q = "SELECT AVG(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR FROM #scope b"
    expect(findAggregateSemanticIssues(q)).toEqual([])
  })

  it("SUM(RevenueZARMTD) AS TotalRevenue is clean", () => {
    // RevenueZARMTD is a row-grain monthly-slice metric in this warehouse
    // (one row per business key per pkMonth). SUMming within a pkMonth
    // yields the correct period total — MTD/YTD/QTD/WTD are intentionally
    // NOT in the pre-aggregation token list.
    const q = "SELECT SUM(r.RevenueZARMTD) AS TotalRevenueZAR FROM #scope r"
    expect(findAggregateSemanticIssues(q)).toEqual([])
  })

  it("SUM(...YTD) / SUM(...QTD) / SUM(...WTD) are clean (period-slice metrics)", () => {
    for (const col of ["RevenueZARYTD", "RevenueZARQTD", "RevenueZARWTD"]) {
      const q = `SELECT SUM(r.${col}) AS TotalRevenueZAR FROM #scope r`
      expect(findAggregateSemanticIssues(q), `${col} should be clean`).toEqual([])
    }
  })

  it("MAX(SpotBalance) AS LatestSpotBalance is clean", () => {
    const q = "SELECT MAX(b.SpotBalanceZAR) AS LatestSpotBalanceZAR FROM #scope b"
    expect(findAggregateSemanticIssues(q)).toEqual([])
  })

  it("comment-only mismatches are ignored", () => {
    const q = "-- SELECT SUM(AverageX) AS AvgX  ←  example only\nSELECT AVG(x) AS AvgX FROM #t"
    expect(findAggregateSemanticIssues(q)).toEqual([])
  })

  it("string-literal mismatches are ignored", () => {
    const q = "SELECT 'SUM(AverageX) AS AvgX' AS doc, AVG(x) AS AvgX FROM #t"
    expect(findAggregateSemanticIssues(q)).toEqual([])
  })

  it("getQueryWarnings returns null for clean query", () => {
    const q = "SELECT AVG(x) AS AvgX FROM #t"
    expect(getQueryWarnings(q)).toBeNull()
  })
})

describe("aggregate-semantic guard — line numbers + snippets", () => {
  it("reports the correct line for a multi-line query", () => {
    const q = "SELECT\n  c.pkClient,\n  SUM(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR\nFROM #scope b"
    const issues = findAggregateSemanticIssues(q)
    expect(issues[0]?.line).toBe(3)
    expect(issues[0]?.snippet).toMatch(/SUM\(b\.AverageCreditBalanceZARMTD\)/)
  })
})
