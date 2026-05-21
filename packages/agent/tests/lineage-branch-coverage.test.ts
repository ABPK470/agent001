/**
 * Lineage branch-coverage advisor (Phase 2).
 *
 * Doctrine: `publish.Revenue` is a UNION ALL over ~59 source-mapping views.
 * A query that ranks from 3 branches but reports from the full view produces
 * a ranking-universe ≠ reporting-universe mismatch (observed in trace
 * 2026-05-21T20-32-25: ~11× revenue understatement on the top client).
 *
 * These tests use a fake lineage catalog so they run without a live runtime.
 */
import { describe, expect, it } from "vitest"

import {
    detectLineageBranchCoverage,
    getQueryWarnings,
} from "../src/tools/mssql/validation.js"

// ── fake lineage catalog ────────────────────────────────────────
function makeLineageCatalog(lineage: Record<string, string[]>) {
  const childToParents = new Map<string, string[]>()
  for (const [parent, branches] of Object.entries(lineage)) {
    for (const b of branches) {
      const lower = b.toLowerCase()
      if (!childToParents.has(lower)) childToParents.set(lower, [])
      childToParents.get(lower)!.push(parent)
    }
  }
  return {
    getLineageParents(qn: string): Array<{ view: string }> {
      return (childToParents.get(qn.toLowerCase()) ?? []).map((view) => ({ view }))
    },
    getLineage(qn: string): { sources: ReadonlyArray<{ qualifiedName: string }> } | null {
      const branches = lineage[qn]
      if (!branches) return null
      return { sources: branches.map((qualifiedName) => ({ qualifiedName })) }
    },
  }
}

const REVENUE_BRANCHES = Array.from({ length: 59 }, (_, i) => `publish.MappingRev${i + 1}`)
const BALANCES_BRANCHES = Array.from({ length: 10 }, (_, i) => `publish.MappingBal${i + 1}`)

const accessor = () =>
  makeLineageCatalog({
    "publish.Revenue": REVENUE_BRANCHES,
    "publish.Balances": BALANCES_BRANCHES,
  })

describe("detectLineageBranchCoverage — gap detection", () => {
  it("flags 3-of-59 ranking shape from the trace", () => {
    const query = [
      "SELECT pkClient, SUM(RevenueZARMTD) AS rev",
      "INTO #topClients",
      "FROM (",
      "  SELECT pkClient, RevenueZARMTD FROM publish.MappingRev1 WHERE pkMonth = 202501",
      "  UNION ALL",
      "  SELECT pkClient, RevenueZARMTD FROM publish.MappingRev2 WHERE pkMonth = 202501",
      "  UNION ALL",
      "  SELECT pkClient, RevenueZARMTD FROM publish.MappingRev3 WHERE pkMonth = 202501",
      ") s GROUP BY pkClient",
    ].join("\n")
    const gaps = detectLineageBranchCoverage(query, accessor)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].parent).toBe("publish.Revenue")
    expect(gaps[0].totalBranches).toBe(59)
    expect(gaps[0].referenced).toEqual([
      "publish.MappingRev1",
      "publish.MappingRev2",
      "publish.MappingRev3",
    ])
  })

  it("does not flag a single-branch reference (treated as intentional)", () => {
    const query = "SELECT * FROM publish.MappingRev1 WHERE pkMonth = 202501"
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("does not flag full coverage", () => {
    const branches = REVENUE_BRANCHES.map((b) => `FROM ${b}`).join(" UNION ALL SELECT 1 ")
    const query = `SELECT 1 ${branches}`
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("respects `-- sampled K of N` escape comment", () => {
    const query = [
      "-- sampled 3 of 59 branches, downstream reporting also restricted",
      "SELECT pkClient FROM publish.MappingRev1",
      "UNION ALL SELECT pkClient FROM publish.MappingRev2",
      "UNION ALL SELECT pkClient FROM publish.MappingRev3",
    ].join("\n")
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("respects `-- branches:` escape comment", () => {
    const query = [
      "-- branches: rev1, rev2 (other branches handled elsewhere)",
      "SELECT pkClient FROM publish.MappingRev1",
      "UNION ALL SELECT pkClient FROM publish.MappingRev2",
    ].join("\n")
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("respects `-- branch-sample` escape comment", () => {
    const query = [
      "-- branch-sample",
      "SELECT pkClient FROM publish.MappingRev1",
      "UNION ALL SELECT pkClient FROM publish.MappingRev2",
    ].join("\n")
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("flags both Revenue and Balances independently when both are partially covered", () => {
    const query = [
      "SELECT pkClient FROM publish.MappingRev1",
      "UNION ALL SELECT pkClient FROM publish.MappingRev2",
      "UNION ALL SELECT pkClient FROM publish.MappingBal1",
      "UNION ALL SELECT pkClient FROM publish.MappingBal2",
    ].join("\n")
    const gaps = detectLineageBranchCoverage(query, accessor)
    expect(gaps.map((g) => g.parent)).toEqual(["publish.Balances", "publish.Revenue"])
  })

  it("returns empty when catalog is unavailable", () => {
    const query = "SELECT 1 FROM publish.MappingRev1 UNION ALL SELECT 1 FROM publish.MappingRev2"
    expect(detectLineageBranchCoverage(query, () => null)).toEqual([])
  })

  it("ignores tables that are not branches of any lineage parent", () => {
    const query = [
      "SELECT * FROM dim.Client c",
      "JOIN dim.Officer o ON o.pkOfficer = c.pkPrimaryOfficer",
    ].join("\n")
    expect(detectLineageBranchCoverage(query, accessor)).toEqual([])
  })

  it("getQueryWarnings includes the lineage gap banner", () => {
    const query = [
      "SELECT pkClient FROM publish.MappingRev1",
      "UNION ALL SELECT pkClient FROM publish.MappingRev2",
      "UNION ALL SELECT pkClient FROM publish.MappingRev3",
    ].join("\n")
    const banner = getQueryWarnings(query, accessor)
    expect(banner).not.toBeNull()
    expect(banner).toMatch(/lineage coverage: publish\.Revenue/)
    expect(banner).toMatch(/59 source branches/)
    expect(banner).toMatch(/only 3 of them/)
  })

  it("getQueryWarnings returns null when there are no gaps and no agg issues", () => {
    expect(getQueryWarnings("SELECT 1", accessor)).toBeNull()
  })
})
