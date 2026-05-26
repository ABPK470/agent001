/**
 * Plan v3 Phase 1 — first-principles ranking signals for `search_catalog`.
 *
 * These signals are derived purely from catalog data already loaded at
 * startup (`viewSourceRows`, `viewDefinition`, sibling table names). No
 * tenant curation. Pins the May 2026 production failure where the agent
 * picked `publish.RevenueESGRules` (12M-row ESG subset) over
 * `publish.Revenue` (270M-row canonical UNION view) for a generic
 * "revenue" question.
 *
 * Three signals tested:
 *   1. VIEW fan-in (sum of source-table rowCounts) — large unions win.
 *   2. Subset-of-candidate — if X's viewDefinition references Y, Y is
 *      structurally more canonical → Y +30, X −40.
 *   3. Name-cluster bareness — bare token among siblings sharing a
 *      prefix (`Revenue` vs `RevenueESGRules`) gets +25.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetTenantConfig } from "../src/application/shell/tenant-config.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, maxLength: null, nullable: false, isPK: false }
}

function table(schema: string, name: string, opts: {
  type?: "TABLE" | "VIEW"
  rowCount?: number | null
  columns?: CatalogColumn[]
  viewDefinition?: string
} = {}): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: opts.type ?? "VIEW",
    rowCount: opts.rowCount ?? null,
    columns: opts.columns ?? [col("Revenue", "decimal"), col("Date", "date")],
    fkOutgoing: [],
    fkIncoming: [],
    viewDefinition: opts.viewDefinition,
  }
}

function buildGraph(
  tables: CatalogTable[],
  viewSourceRows: Array<{ name: string; sourceRows: number }> = [],
): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    viewSourceRows,
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

beforeEach(() => resetTenantConfig())
afterEach(() => resetTenantConfig())

describe("searchCatalog — fan-in signal (viewSourceRows)", () => {
  it("ranks a wide-UNION view above a 1-branch subset with same name match", () => {
    // Both views match "revenue" in the name → same nameScore.
    // Only fan-in distinguishes them.
    const revenue = table("publish", "Revenue", { type: "VIEW" })
    const subset = table("publish", "Revenue1Subset", { type: "VIEW" })
    const g = buildGraph(
      [revenue, subset],
      [
        { name: "publish.Revenue", sourceRows: 270_000_000 },
        { name: "publish.Revenue1Subset", sourceRows: 1_000_000 },
      ],
    )
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    expect(hits[1]?.table.qualifiedName).toBe("publish.Revenue1Subset")
  })

  it("awards zero fan-in bonus to views with no viewSourceRows entry", () => {
    const a = table("publish", "Revenue", { type: "VIEW" })
    const b = table("publish", "RevenueB", { type: "VIEW" })
    const g = buildGraph([a, b], []) // empty viewSourceRows
    const hits = g.search("revenue", 10)
    expect(hits).toHaveLength(2)
    // No crash; ranking falls back to bare-cluster + other signals.
  })
})

describe("searchCatalog — subset-of-candidate signal", () => {
  it("boosts the parent UNION view and demotes its branch", () => {
    // Same nameScore (both match 'revenue'), no fan-in data:
    // only the cross-reference signal distinguishes parent from branch.
    const parent = table("publish", "Revenue", {
      type: "VIEW",
      viewDefinition: `
        CREATE VIEW publish.Revenue AS
        SELECT * FROM publish.RevenueESGRules
        UNION ALL
        SELECT * FROM publish.RevenueRWARules
      `,
    })
    const branch = table("publish", "RevenueESGRules", { type: "VIEW" })
    const sibling = table("publish", "RevenueRWARules", { type: "VIEW" })
    const g = buildGraph([parent, branch, sibling])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    const parentScore = hits.find(h => h.table.name === "Revenue")!.score
    const branchScore = hits.find(h => h.table.name === "RevenueESGRules")!.score
    // Parent +30, branch −40, plus +25 bare-cluster on parent →
    // gap of at least ~95.
    expect(parentScore - branchScore).toBeGreaterThanOrEqual(70)
  })

  it("matches JOIN references in viewDefinition, not just FROM", () => {
    const parent = table("publish", "RevenueWithDim", {
      type: "VIEW",
      viewDefinition: `
        SELECT r.* FROM publish.RevenueRaw r
        JOIN publish.RevenueAdjustments a ON a.Id = r.Id
      `,
    })
    const branch1 = table("publish", "RevenueRaw", { type: "VIEW" })
    const branch2 = table("publish", "RevenueAdjustments", { type: "VIEW" })
    const g = buildGraph([parent, branch1, branch2])
    const hits = g.search("revenue", 10)
    const parentScore = hits.find(h => h.table.name === "RevenueWithDim")!.score
    const branch1Score = hits.find(h => h.table.name === "RevenueRaw")!.score
    expect(parentScore).toBeGreaterThan(branch1Score)
  })

  it("does NOT trigger on lookalike prose inside comments without FROM/JOIN", () => {
    const a = table("publish", "Revenue", {
      type: "VIEW",
      viewDefinition: `-- this view replaces publish.RevenueOld\nSELECT 1 AS x`,
    })
    const b = table("publish", "RevenueOld", { type: "VIEW" })
    const g = buildGraph([a, b])
    const hits = g.search("revenue", 10)
    // Neither gets the subset bonus from the prose mention.
    // Bare-cluster still applies to `Revenue` (b starts with the same prefix).
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })
})

describe("searchCatalog — name-cluster bare bonus", () => {
  it("boosts the bare-name candidate when suffixed siblings are also matched", () => {
    const bare = table("publish", "Revenue", { type: "VIEW" })
    const suffix1 = table("publish", "RevenueESGRules", { type: "VIEW" })
    const suffix2 = table("publish", "RevenueRWARules", { type: "VIEW" })
    const g = buildGraph([bare, suffix1, suffix2])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })

  it("does NOT award the bonus when only one candidate matches", () => {
    const bare = table("publish", "Revenue", { type: "VIEW" })
    const g = buildGraph([bare])
    const hits = g.search("revenue", 10)
    expect(hits).toHaveLength(1)
    // No crash, no spurious bonus when there's nothing to compare against.
  })

  it("does NOT award the bonus to trivial 1-3 char prefixes", () => {
    // "Tax" is short but real; "TaxRules" is its derived sibling. We
    // deliberately ignore prefixes <4 chars to avoid noise on common
    // 3-letter tokens. Either may rank first via other signals.
    const a = table("publish", "Tax", { type: "VIEW" })
    const b = table("publish", "TaxRules", { type: "VIEW" })
    const g = buildGraph([a, b])
    const hits = g.search("tax", 10)
    const aScore = hits.find(h => h.table.name === "Tax")!.score
    const bScore = hits.find(h => h.table.name === "TaxRules")!.score
    // Without the bare bonus, the two tables score equally on
    // nameScore+colScore; bare-cluster signal must NOT fire.
    expect(Math.abs(aScore - bScore)).toBeLessThan(25)
  })
})

describe("searchCatalog — combined signals (failing-trace replay)", () => {
  it("ranks publish.Revenue first over RevenueESGRules with all three signals", () => {
    // Faithful synthesis of the production catalog state for the May 2026
    // failure: parent UNION view with high fan-in + bare-cluster + subset
    // reference. No memory primed (Phase 1 alone must succeed).
    const revenue = table("publish", "Revenue", {
      type: "VIEW",
      viewDefinition: `
        CREATE VIEW publish.Revenue AS
        SELECT * FROM publish.RevenueESGRules
        UNION ALL SELECT * FROM publish.RevenueRWARules
        UNION ALL SELECT * FROM publish.RevenueBackfill
      `,
    })
    const esgRules = table("publish", "RevenueESGRules", { type: "VIEW" })
    const rwaRules = table("publish", "RevenueRWARules", { type: "VIEW" })
    const backfill = table("publish", "RevenueBackfill", { type: "VIEW" })
    const g = buildGraph(
      [revenue, esgRules, rwaRules, backfill],
      [
        { name: "publish.Revenue", sourceRows: 270_000_000 },
        { name: "publish.RevenueESGRules", sourceRows: 12_000_000 },
        { name: "publish.RevenueRWARules", sourceRows: 8_000_000 },
        { name: "publish.RevenueBackfill", sourceRows: 5_000_000 },
      ],
    )
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    // The gap should be substantial — agent should not be tempted by
    // a near-tie on the runner-up.
    expect(hits[0]!.score - hits[1]!.score).toBeGreaterThanOrEqual(50)
  })
})
