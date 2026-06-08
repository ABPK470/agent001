/**
 * Phase 3 wiring — resolvedFacts block assembly.
 *
 * Verifies the pure helper:
 *   - returns "" when nothing relevant is present
 *   - surfaces ALWAYS_TRACKED objects when the catalog has them
 *   - reports persistedView mirror presence honestly
 *   - extracts goal-mentioned objects (case-insensitive, brackets tolerated)
 *   - never throws on a missing catalog
 */
import type { CatalogColumn, CatalogTable } from "@mia/agent"
import { CatalogGraph } from "@mia/agent"
import { describe, expect, it } from "vitest"
import {
  buildResolvedFactsBlock,
  extractObjectTokens
} from "../src/features/runs/core/data-blocks/resolved-facts-block.js"

function col(name: string): CatalogColumn {
  return { name, dataType: "int", nullable: false } as CatalogColumn
}
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
    fkIncoming: []
  }
}

function graph(tables: CatalogTable[]): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 7,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    viewSourceRows: [],
    sysCatalog: []
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
      table("persistedView.publish.Revenue", ["pkClient", "amount"])
    ])
    const out = buildResolvedFactsBlock({
      goal: "compute total publish.Revenue",
      catalog: cat,
      mirrorSchema: "persistedView"
    })
    expect(out).toContain("publish.revenue")
    expect(out).toContain("persistedView mirror EXISTS")
  })

  it("reports NO mirror when the persistedView is absent", () => {
    const cat = graph([table("publish.Revenue", ["pkClient", "amount"])])
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: cat,
      mirrorSchema: "persistedView"
    })
    expect(out).toContain("no persistedView mirror")
  })

  it("skips ALWAYS_TRACKED objects that don't exist anywhere", () => {
    const out = buildResolvedFactsBlock({
      goal: "compute foo bar baz",
      catalog: graph([])
    })
    expect(out).toBe("")
  })

  it("threads schemaFingerprint into the block", () => {
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: graph([table("publish.Revenue", ["pkClient"])]),
      schemaFingerprint: "sha1:deadbeef"
    })
    expect(out).toContain("schema fingerprint: sha1:deadbeef")
  })

  it("does not throw with a null catalog", () => {
    expect(() => buildResolvedFactsBlock({ goal: "publish.Revenue", catalog: null })).not.toThrow()
  })
})
