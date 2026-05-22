/**
 * Plan v3 Phase 6 — canonical-ambiguity clarifier.
 *
 * Fires WARN when the top-1 catalog hit is within 15% of the top-2 hit
 * AND the goal contains a tenant-configured domain keyword. Suppresses
 * on qualified names and pronominal follow-ups.
 *
 * No catalog fixtures or names hard-coded into the agent — the test
 * supplies its own minimal `CatalogGraph` and tenant `routingKeywords`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { canonicalAmbiguityDetector } from "../src/clarify/detectors/canonical-ambiguity.js"
import type { ClarifyContext } from "../src/clarify/types.js"
import { MessageRole } from "../src/domain/enums/message.js"
import { getTenantConfig, resetTenantConfig, setTenantConfig } from "../src/tenant/config.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

// ── fixtures ─────────────────────────────────────────────────────

function col(name: string, dataType = "decimal"): CatalogColumn {
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
    columns: opts.columns ?? [col("Revenue"), col("Date", "date")],
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

function makeCtx(opts: {
  goal: string
  catalog: CatalogGraph | null
  messages?: ClarifyContext["messages"]
  round?: number
}): ClarifyContext {
  return {
    goal: opts.goal,
    catalog: opts.catalog,
    tenant: getTenantConfig(),
    messages: opts.messages ?? [],
    resolved: [],
    round: opts.round ?? 1,
  }
}

beforeEach(() => {
  resetTenantConfig()
  setTenantConfig({ routingKeywords: { schemas: [], domain: ["revenue", "exposure"], sync: [] } })
})
afterEach(() => resetTenantConfig())

// ── tests ────────────────────────────────────────────────────────

describe("canonicalAmbiguityDetector", () => {
  it("does not fire when catalog is null", () => {
    const ctx = makeCtx({ goal: "show revenue", catalog: null })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })

  it("does not fire when goal contains no domain keyword", () => {
    // 'sales' is NOT in the tenant domain keywords above.
    const a = table("publish", "Sales", { type: "VIEW" })
    const b = table("publish", "SalesSubset", { type: "VIEW" })
    const ctx = makeCtx({ goal: "show sales for april", catalog: buildGraph([a, b]) })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })

  it("suppresses when goal names a qualified table that resolves in the catalog", () => {
    const a = table("publish", "Revenue", { type: "VIEW" })
    const b = table("publish", "RevenueSubset", { type: "VIEW" })
    const ctx = makeCtx({
      goal: "top products by revenue from publish.Revenue for april 2025",
      catalog: buildGraph([a, b]),
    })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })

  it("suppresses on pronominal follow-up after an assistant turn", () => {
    const a = table("publish", "Revenue", { type: "VIEW" })
    const b = table("publish", "RevenueSubset", { type: "VIEW" })
    const ctx = makeCtx({
      goal: "now filter that revenue table to April",
      catalog: buildGraph([a, b]),
      messages: [{ role: MessageRole.Assistant, content: "Here are the top products." }],
    })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })

  it("does not fire when there's a clear winner (gap >= 15%)", () => {
    // Wide UNION view with huge fan-in → score gap > 15%.
    const wide = table("publish", "Revenue", { type: "VIEW" })
    const narrow = table("publish", "RevenueOther", { type: "VIEW" })
    const ctx = makeCtx({
      goal: "top products by revenue for april",
      catalog: buildGraph(
        [wide, narrow],
        [
          { name: "publish.Revenue", sourceRows: 500_000_000 },
          { name: "publish.RevenueOther", sourceRows: 100 },
        ],
      ),
    })
    const findings = canonicalAmbiguityDetector.detect(ctx)
    // wide will lead by a lot — gap should exceed 15%.
    expect(findings).toEqual([])
  })

  it("FIRES warn when top-1 vs top-2 scores are within 15% on a metric goal", () => {
    // Two non-prefix-related candidates → no name-cluster bonus for either,
    // identical column shape → scores essentially equal (gap = 0%).
    const a = table("publish", "Revenue", { type: "VIEW", rowCount: 1_000_000 })
    const b = table("publish", "OtherRevenue", { type: "VIEW", rowCount: 1_000_000 })
    const ctx = makeCtx({
      goal: "top products by revenue for april 2025",
      catalog: buildGraph([a, b]),
    })
    const findings = canonicalAmbiguityDetector.detect(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe("canonical-ambiguity")
    expect(findings[0].severity).toBe("warn")
    expect(findings[0].subject).toBe("revenue")
    expect(findings[0].candidates).toBeDefined()
    expect(findings[0].candidates!.length).toBeGreaterThanOrEqual(2)
    expect(findings[0].suggestedQuestion).toContain("revenue")
  })

  it("finding id is stable across calls for the same subject", () => {
    const a = table("publish", "Revenue", { type: "VIEW" })
    const b = table("publish", "OtherRevenue", { type: "VIEW" })
    const ctx = makeCtx({
      goal: "top products by revenue",
      catalog: buildGraph([a, b]),
    })
    const id1 = canonicalAmbiguityDetector.detect(ctx)[0]?.id
    const id2 = canonicalAmbiguityDetector.detect(ctx)[0]?.id
    expect(id1).toBeDefined()
    expect(id1).toBe(id2)
    expect(id1).toBe("canonical-ambiguity:revenue")
  })

  it("does not fire when only one candidate matches", () => {
    const only = table("publish", "Revenue", { type: "VIEW" })
    const unrelated = table("dim", "Client", { type: "TABLE", columns: [col("ClientId", "int")] })
    const ctx = makeCtx({
      goal: "top products by revenue",
      catalog: buildGraph([only, unrelated]),
    })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })

  it("does not fire when tenant has no domain keywords configured", () => {
    resetTenantConfig() // wipes domain keywords back to []
    const a = table("publish", "Revenue", { type: "VIEW", rowCount: 1_000_000 })
    const b = table("publish", "RevenueRules", { type: "VIEW", rowCount: 1_000_000 })
    const ctx = makeCtx({
      goal: "top products by revenue for april",
      catalog: buildGraph([a, b]),
    })
    expect(canonicalAmbiguityDetector.detect(ctx)).toEqual([])
  })
})
