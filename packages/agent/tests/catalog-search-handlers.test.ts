/**
 * Catalog search handlers — case-insensitive + mirror-aware lookup.
 *
 * Pins the May 2026 production gap: the agent called
 *   search_catalog({"connection":"dev","table":"publish.revenue"})
 * and the handler responded `Table 'publish.revenue' not found.` even
 * though the catalog stored the wide curated view as `publish.Revenue`
 * AND also as the persisted-mirror `persistedView.publish.Revenue`.
 *
 * Two independent failure modes, both fixed:
 *   1. Case-sensitivity — `CatalogGraph.getTable` was a raw Map lookup.
 *   2. Mirror unawareness — the deployment doctrine (every prompt
 *      reference, every error hint) tells the LLM to use the base
 *      name `publish.revenue`, but the catalog only carries the
 *      `<mirrorSchema>.<base>` 3-part form on some deployments.
 *      `handleTable` / `handleJoins` now bridge that gap.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetTenantConfig, setTenantConfig } from "../src/domain/tenant/tenant-config.js"
import { handleJoins, handleTable } from "../src/tools/catalog-search/handlers.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int", isPK = false): CatalogColumn {
  return { name, dataType, maxLength: null, nullable: false, isPK }
}

function table(
  schema: string,
  name: string,
  opts: {
    type?: "TABLE" | "VIEW"
    columns?: CatalogColumn[]
    rowCount?: number | null
  } = {}
): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: opts.type ?? "TABLE",
    rowCount: opts.rowCount ?? null,
    columns: opts.columns ?? [col("Id", "int", true)],
    fkOutgoing: [],
    fkIncoming: [],
    viewDefinition: undefined
  }
}

function buildGraph(tables: CatalogTable[]): CatalogGraph {
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

beforeEach(() => resetTenantConfig())
afterEach(() => resetTenantConfig())

describe("CatalogGraph.getTable — case-insensitive", () => {
  it("finds a table when the request matches the canonical casing", () => {
    const g = buildGraph([table("publish", "Revenue", { type: "VIEW", rowCount: 100 })])
    expect(g.getTable("publish.Revenue")?.qualifiedName).toBe("publish.Revenue")
  })

  it("finds a table when the request is all lowercase", () => {
    const g = buildGraph([table("publish", "Revenue", { type: "VIEW", rowCount: 100 })])
    // The actual production bug: LLM sent lowercase, catalog stored mixed.
    expect(g.getTable("publish.revenue")?.qualifiedName).toBe("publish.Revenue")
  })

  it("finds a table when the request is all uppercase", () => {
    const g = buildGraph([table("publish", "Revenue", { type: "VIEW", rowCount: 100 })])
    expect(g.getTable("PUBLISH.REVENUE")?.qualifiedName).toBe("publish.Revenue")
  })

  it("finds a table when only the schema differs in case", () => {
    const g = buildGraph([table("Publish", "Revenue", { type: "VIEW" })])
    expect(g.getTable("publish.revenue")?.qualifiedName).toBe("Publish.Revenue")
  })

  it("returns null when the name truly isn't in the catalog (any case)", () => {
    const g = buildGraph([table("publish", "Revenue", { type: "VIEW" })])
    expect(g.getTable("publish.Foobar")).toBeNull()
    expect(g.getTable("PUBLISH.FOOBAR")).toBeNull()
  })
})

describe("handleTable — mirror-aware fallback", () => {
  it("resolves `publish.revenue` against the mirror `<mirrorSchema>.publish.Revenue`", () => {
    // Mirror-only deployment: the bare 2-part view isn't in the catalog,
    // only the 3-part persisted mirror is. The handler must bridge this.
    setTenantConfig({ mirrorSchema: "persistedView" })
    const g = buildGraph([
      table("persistedView", "publish.Revenue", {
        type: "VIEW",
        rowCount: 12_345_678,
        columns: [col("pkClient", "int", true), col("Amount", "decimal")]
      })
    ])
    const out = handleTable(g, "publish.revenue")
    expect(out).toContain("persistedView.publish.Revenue")
    expect(out).toContain("resolved via mirror (input was 'publish.revenue')")
    expect(out).toContain("pkClient")
    expect(out).toContain("Amount")
  })

  it("prefers the direct hit over the mirror when both exist", () => {
    setTenantConfig({ mirrorSchema: "persistedView" })
    const g = buildGraph([
      table("publish", "Revenue", { type: "VIEW", rowCount: 99 }),
      table("persistedView", "publish.Revenue", { type: "VIEW", rowCount: 12_345_678 })
    ])
    const out = handleTable(g, "publish.revenue")
    // Direct hit returns first — no "resolved via mirror" annotation.
    expect(out).toMatch(/^publish\.Revenue \(VIEW, ~?99 rows?\)/)
    expect(out).not.toContain("resolved via mirror")
  })

  it("does NOT recurse when the user already asks for the mirror form", () => {
    setTenantConfig({ mirrorSchema: "persistedView" })
    const g = buildGraph([table("persistedView", "publish.Revenue", { type: "VIEW", rowCount: 999 })])
    const out = handleTable(g, "persistedView.publish.Revenue")
    expect(out).toContain("persistedView.publish.Revenue")
    expect(out).not.toContain("resolved via mirror")
  })

  it("falls back to fuzzy suggestions when neither direct nor mirror hits", () => {
    setTenantConfig({ mirrorSchema: "persistedView" })
    const g = buildGraph([table("publish", "PNLRevenue", { type: "VIEW" })])
    const out = handleTable(g, "publish.totallyMadeUp")
    expect(out).toMatch(/not found\. Did you mean:/)
  })
})

describe("handleJoins — mirror-aware fallback", () => {
  it("resolves the mirror form and reports it in the header", () => {
    setTenantConfig({ mirrorSchema: "persistedView" })
    const g = buildGraph([table("persistedView", "publish.Revenue", { type: "VIEW", rowCount: 100 })])
    const out = handleJoins(g, "publish.revenue")
    expect(out).toContain("Join edges for persistedView.publish.Revenue")
    expect(out).toContain("resolved via mirror from 'publish.revenue'")
  })
})
