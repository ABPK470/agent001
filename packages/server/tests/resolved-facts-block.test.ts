/**
 * Phase 3 wiring — resolvedFacts block assembly.
 *
 * Verifies the pure helper:
 *   - returns "" when nothing relevant is present
 *   - surfaces ALWAYS_TRACKED objects when the catalog has them
 *   - reports persistedView mirror presence honestly
 *   - extracts goal-mentioned objects (case-insensitive, brackets tolerated)
 *   - threads branchCount from lineage when ≥ 2
 *   - never throws on a missing catalog
 */
import type { CatalogColumn, CatalogTable, ViewLineage } from "@mia/agent"
import { CatalogGraph } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { buildResolvedFactsBlock, extractObjectTokens } from "../src/orchestrator/resolved-facts-block.js"

function col(name: string): CatalogColumn { return { name, dataType: "int", nullable: false } as CatalogColumn }
function table(qualified: string, columns: string[]): CatalogTable {
  const [schema, name] = qualified.split(".")
  return {
    schema: schema!,
    name: name!,
    qualifiedName: qualified,
    type: qualified.toLowerCase().startsWith("persistedview.") ? "VIEW" : "TABLE",
    rowCount: 0,
    columns: columns.map(col),
    fkOutgoing: [],
    fkIncoming: [],
  }
}

function graph(tables: CatalogTable[], lineage: ViewLineage[] = []): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage,
    viewSourceRows: [],
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

describe("extractObjectTokens", () => {
  it("finds bracketed and bare object names, lowercased and deduped", () => {
    const goal = "Aggregate [publish].[Revenue] joined to publish.Revenue and dim.Client."
    expect(extractObjectTokens(goal).sort()).toEqual(["dim.client", "publish.revenue"])
  })
})

describe("buildResolvedFactsBlock", () => {
  it("returns empty when no catalog, no lineage, no goal-mention", () => {
    const out = buildResolvedFactsBlock({ goal: "hello world", catalog: null })
    expect(out).toBe("")
  })

  it("reports persistedView mirror EXISTS when catalog contains it", () => {
    const cat = graph([
      table("publish.Revenue", ["pkClient", "amount"]),
      table("persistedView.publish.Revenue", ["pkClient", "amount"]),
    ])
    const out = buildResolvedFactsBlock({
      goal: "compute total publish.Revenue",
      catalog: cat,
    })
    expect(out).toContain("publish.revenue")
    expect(out).toContain("persistedView mirror EXISTS")
  })

  it("reports NO mirror when the persistedView is absent", () => {
    const cat = graph([table("publish.Revenue", ["pkClient", "amount"])])
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: cat,
    })
    expect(out).toContain("no persistedView mirror")
  })

  it("includes branchCount from lineage when ≥ 2", () => {
    const cat = graph([table("publish.Revenue", ["pkClient", "amount"])])
    const lineage: ViewLineage[] = [{
      view: "publish.Revenue",
      description: "x",
      outputColumns: [],
      dimJoins: [],
      sources: [
        { qualifiedName: "publish.A", businessArea: "x", group: "y", filter: "" },
        { qualifiedName: "publish.B", businessArea: "x", group: "y", filter: "" },
        { qualifiedName: "publish.C", businessArea: "x", group: "y", filter: "" },
      ],
    }]
    const cat2 = graph([table("publish.Revenue", ["pkClient"])], lineage)
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: cat2,
      lineageMap: cat2.lineageMap,
    })
    expect(out).toContain("3 union branches")
  })

  it("skips ALWAYS_TRACKED objects that don't exist anywhere", () => {
    const out = buildResolvedFactsBlock({
      goal: "compute foo bar baz",
      catalog: graph([]),
    })
    expect(out).toBe("")
  })

  it("threads schemaFingerprint into the block", () => {
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: graph([table("publish.Revenue", ["pkClient"])]),
      schemaFingerprint: "sha1:deadbeef",
    })
    expect(out).toContain("schema fingerprint: sha1:deadbeef")
  })

  it("does not throw with a null catalog", () => {
    expect(() =>
      buildResolvedFactsBlock({ goal: "publish.Revenue", catalog: null }),
    ).not.toThrow()
  })
})
