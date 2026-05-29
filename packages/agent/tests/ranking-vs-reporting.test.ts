/**
 * Cross-source reconciliation guard (Phase 5).
 *
 * Detects the trace-2026-05-21 pattern: rank from a #temp built from a
 * sub-universe, then SUM publish.Revenue (full universe) without filtering
 * to the same predicates. Soft-warn; escape with `-- universes intentional`.
 */
import { describe, expect, it } from "vitest"

import {
    detectRankingVsReportingMismatch,
    getQueryWarnings,
} from "../src/tools/mssql/validation.js"

describe("detectRankingVsReportingMismatch", () => {
  it("fires when a #temp + publish.Revenue are aggregated together", () => {
    const query = [
      "SELECT t.pkClient, SUM(r.Revenue) AS TotalRevenue",
      "FROM #topClients t",
      "JOIN publish.Revenue r ON r.pkClient = t.pkClient",
      "GROUP BY t.pkClient",
    ].join("\n")
    const result = detectRankingVsReportingMismatch(query)
    expect(result).not.toBeNull()
    expect(result?.bigViews).toEqual(["publish.revenue"])
  })

  it("fires for publish.Balances + #temp + COUNT", () => {
    const query = [
      "SELECT t.pkBranch, COUNT(*) AS n",
      "FROM #brkBranches t",
      "JOIN publish.Balances b ON b.pkBranch = t.pkBranch",
      "GROUP BY t.pkBranch",
    ].join("\n")
    expect(detectRankingVsReportingMismatch(query)).not.toBeNull()
  })

  it("does NOT fire when the universes-intentional escape comment is present", () => {
    const query = [
      "-- universes intentional",
      "SELECT t.pkClient, SUM(r.Revenue) AS TotalRevenue",
      "FROM #topClients t",
      "JOIN publish.Revenue r ON r.pkClient = t.pkClient",
      "GROUP BY t.pkClient",
    ].join("\n")
    expect(detectRankingVsReportingMismatch(query)).toBeNull()
  })

  it("does NOT fire when there is no #temp table", () => {
    const query = "SELECT SUM(Revenue) FROM publish.Revenue WHERE pkMonth = 202501"
    expect(detectRankingVsReportingMismatch(query)).toBeNull()
  })

  it("does NOT fire when there is no big view (just #temp + dim join)", () => {
    const query = [
      "SELECT t.pkClient, SUM(t.Revenue)",
      "FROM #topClients t",
      "JOIN dim.Client c ON c.pkClient = t.pkClient",
      "GROUP BY t.pkClient",
    ].join("\n")
    expect(detectRankingVsReportingMismatch(query)).toBeNull()
  })

  it("does NOT fire without an aggregate function in the SELECT", () => {
    const query = [
      "SELECT t.pkClient, r.Revenue",
      "FROM #topClients t",
      "JOIN publish.Revenue r ON r.pkClient = t.pkClient",
    ].join("\n")
    expect(detectRankingVsReportingMismatch(query)).toBeNull()
  })

  it("getQueryWarnings includes the universe-mismatch banner", () => {
    const query = [
      "SELECT t.pkClient, SUM(r.Revenue) AS TotalRevenue",
      "FROM #topClients t",
      "JOIN publish.Revenue r ON r.pkClient = t.pkClient",
      "GROUP BY t.pkClient",
    ].join("\n")
    const banner = getQueryWarnings(query, {
      lineageAccessor: () => null,
      profiledTables: new Set(["publish.revenue"]),
    })
    expect(banner).not.toBeNull()
    expect(banner).toMatch(/universe mismatch/)
    expect(banner).toMatch(/-- universes intentional/)
  })
})
