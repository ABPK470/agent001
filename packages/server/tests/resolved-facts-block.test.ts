/**
 * resolvedFacts block assembly.
 *
 * Verifies the pure helper:
 *   - returns "" when nothing goal-relevant is present (no ambient top-N dump)
 *   - reports persistedView mirror presence honestly for goal-named objects
 *   - extracts goal-mentioned objects (case-insensitive, brackets tolerated)
 *   - never throws on a missing catalog
 */
import type { CatalogColumn, CatalogTable } from "@mia/agent"
import { CatalogGraph } from "@mia/agent"
import { describe, expect, it } from "vitest"
import {
  buildResolvedFactsBlock,
  extractObjectTokens
} from "../src/api/runs/prompting/data-blocks/resolved-facts-block.js"

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

  it("returns empty when goal has no object tokens and catalog is empty", () => {
    const out = buildResolvedFactsBlock({
      goal: "compute foo bar baz",
      catalog: graph([])
    })
    expect(out).toBe("")
  })

  it("does not dump top catalog large objects into unrelated goals (e.g. Hi)", () => {
    const cat = graph([
      table("archive.account", ["id"]),
      table("publish.Revenue", ["pkClient", "amount"]),
      table("dim.Client", ["pkClient"])
    ])
    // Large row counts must not force inclusion — only goal relevance does.
    for (const [, t] of cat.tables) {
      ;(t as { rowCount: number }).rowCount = 50_000_000
    }
    const out = buildResolvedFactsBlock({
      goal: "Hi",
      catalog: cat,
      schemaFingerprint: "sha1:deadbeef"
    })
    expect(out).toBe("")
  })

  it("still surfaces objects the goal actually names", () => {
    const cat = graph([table("publish.Revenue", ["pkClient", "amount"])])
    const out = buildResolvedFactsBlock({
      goal: "scan publish.Revenue",
      catalog: cat
    })
    expect(out).toContain("publish.revenue")
  })

  it("threads schemaFingerprint into the block only when there are goal facts", () => {
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
