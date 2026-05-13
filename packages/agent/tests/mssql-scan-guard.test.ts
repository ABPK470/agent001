/**
 * Tests for the MSSQL scan guard — ensures the tool never executes
 * unfiltered queries against known large tables/views.
 *
 * These patterns caused multi-minute timeouts in production:
 *   SELECT TOP 5 pkMonth FROM publish.Revenue ORDER BY pkMonth
 *   SELECT COUNT(*) FROM fact.UnoTranspose
 * The guard must block them at the tool layer before they hit the DB.
 */

import { describe, expect, it } from "vitest"
import {
    hasWhereClause,
    isUnsafeScan,
    referencedLargeObjects,
} from "../src/tools/index.js"

// ── referencedLargeObjects ────────────────────────────────────────

describe("referencedLargeObjects", () => {
  it("detects a plain large view", () => {
    expect(referencedLargeObjects("SELECT * FROM publish.Revenue")).toContain("publish.revenue")
  })

  it("detects bracketed names", () => {
    expect(referencedLargeObjects("SELECT * FROM [publish].[Revenue]")).toContain("publish.revenue")
  })

  it("detects large fact table", () => {
    expect(referencedLargeObjects("SELECT TOP 10 * FROM fact.UnoTranspose WHERE x=1")).toContain("fact.unotranspose")
  })

  it("returns empty for small/unknown tables", () => {
    expect(referencedLargeObjects("SELECT * FROM core.Pipeline")).toHaveLength(0)
    expect(referencedLargeObjects("SELECT * FROM dim.Date WHERE calYear=2025")).toHaveLength(0)
  })

  it("detects multiple large objects in one query", () => {
    const refs = referencedLargeObjects(
      "SELECT * FROM publish.Revenue r JOIN dim.Client c ON r.pkClient = c.pkClient",
    )
    expect(refs).toContain("publish.revenue")
    expect(refs).toContain("dim.client")
  })
})

// ── hasWhereClause ────────────────────────────────────────────────

describe("hasWhereClause", () => {
  it("returns true when WHERE is present", () => {
    expect(hasWhereClause("SELECT * FROM publish.Revenue WHERE pkMonth = 733")).toBe(true)
  })

  it("returns false when no WHERE", () => {
    expect(hasWhereClause("SELECT TOP 5 pkMonth FROM publish.Revenue ORDER BY pkMonth")).toBe(false)
  })

  it("ignores WHERE inside string literals", () => {
    // A string containing the word WHERE should not count
    expect(hasWhereClause("SELECT 'filter WHERE x=1' FROM publish.Revenue")).toBe(false)
  })
})

// ── isUnsafeScan ─────────────────────────────────────────────────

describe("isUnsafeScan — should BLOCK these queries", () => {
  const block = (query: string) => {
    const refs = referencedLargeObjects(query)
    return isUnsafeScan(query, refs)
  }

  it("blocks SELECT TOP N without WHERE on large view", () => {
    expect(block("SELECT TOP 5 pkMonth FROM publish.Revenue ORDER BY pkMonth")).not.toBeNull()
  })

  it("blocks COUNT(*) without WHERE on large table", () => {
    expect(block("SELECT COUNT(*) FROM fact.UnoTranspose")).not.toBeNull()
  })

  it("blocks DISTINCT without WHERE on large view", () => {
    expect(block("SELECT DISTINCT pkMonth FROM publish.Revenue")).not.toBeNull()
  })

  it("blocks MIN/MAX aggregate without WHERE on large view", () => {
    expect(block("SELECT MIN(pkMonth), MAX(pkMonth) FROM publish.Revenue")).not.toBeNull()
  })

  it("blocks unfiltered SELECT * on large fact table", () => {
    expect(block("SELECT * FROM fact.AfricaFlexDailyBalances")).not.toBeNull()
  })

  it("blocks SUM aggregate without WHERE on large view", () => {
    expect(block("SELECT SUM(RevenueZARMTD) FROM publish.Revenue")).not.toBeNull()
  })
})

describe("isUnsafeScan — should ALLOW these queries", () => {
  const allow = (query: string) => {
    const refs = referencedLargeObjects(query)
    return isUnsafeScan(query, refs)
  }

  it("allows query with WHERE clause on large view", () => {
    expect(allow(
      "SELECT TOP 5 pkMonth FROM publish.Revenue WITH (NOLOCK) WHERE pkMonth = 733",
    )).toBeNull()
  })

  it("allows aggregation WITH WHERE on large view", () => {
    expect(allow(
      "SELECT TOP 20 pkClient, SUM(RevenueZARMTD) FROM publish.Revenue WHERE pkMonth BETWEEN 733 AND 744 GROUP BY pkClient",
    )).toBeNull()
  })

  it("allows MIN on dim.Date (not a large object)", () => {
    expect(allow(
      "SELECT MIN(pkDate) FROM dim.Date WITH (NOLOCK) WHERE calYear = 2025",
    )).toBeNull()
  })

  it("allows any query on small/unknown tables", () => {
    expect(allow("SELECT TOP 10 * FROM core.Pipeline")).toBeNull()
    expect(allow("SELECT COUNT(*) FROM core.Activity")).toBeNull()
  })

  it("allows CTEs that provide a WHERE in the outer query", () => {
    expect(allow(`
      WITH months AS (SELECT MIN(pkDate) AS m FROM dim.Date WHERE calYear=2025)
      SELECT pkClient, SUM(RevenueZARMTD) FROM publish.Revenue
      WHERE pkMonth = (SELECT m FROM months)
      GROUP BY pkClient
    `)).toBeNull()
  })
})
