import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { schemaMatchDetector } from "../src/application/core/clarify-cluster/detectors/schema-match.js"
import {
  resolveGoalDataAnchors
} from "../src/application/core/clarify-cluster/goal-data-anchors.js"
import type { ClarifyContext } from "../src/application/core/clarify-cluster/types.js"
import {
  DEFAULT_TENANT_CONFIG,
  resetTenantConfig,
  setTenantConfig,
  type TenantConfig
} from "../src/application/shell/tenant-config.js"
import { handleSearch } from "../src/tools/catalog-search/search-handlers.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string): CatalogColumn {
  return { name, dataType: "int", maxLength: null, nullable: false, isPK: false }
}

function table(
  schema: string,
  name: string,
  opts: { type?: "TABLE" | "VIEW"; rowCount?: number | null } = {}
): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: opts.type ?? "TABLE",
    rowCount: opts.rowCount ?? 1000,
    columns: [col("Id", "int", true)],
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

function ctx(overrides: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    catalog: null,
    tenant: DEFAULT_TENANT_CONFIG,
    messages: [],
    resolved: [],
    round: 1,
    ...overrides
  }
}

beforeEach(() => resetTenantConfig())
afterEach(() => resetTenantConfig())

describe("resolveGoalDataAnchors", () => {
  it("resolves exact qualified names case-insensitively", () => {
    const cat = buildGraph([table("ai", "RevenueMart", { rowCount: 50_000 })])
    const anchors = resolveGoalDataAnchors("analysis on ai.revenuemart for q4", cat)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.qualifiedName).toBe("ai.RevenueMart")
    expect(anchors[0]!.resolution).toBe("exact")
  })

  it("fuzzy-resolves minor typos within the stated schema", () => {
    const cat = buildGraph([table("ai", "RevenueMart", { rowCount: 50_000 })])
    const anchors = resolveGoalDataAnchors("based on uat ai.revenuMart data", cat)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.qualifiedName).toBe("ai.RevenueMart")
    expect(anchors[0]!.resolution).toBe("fuzzy")
  })

  it("resolves mirror-qualified references", () => {
    setTenantConfig({ mirrorSchema: "persistedView" })
    const cat = buildGraph([table("persistedView", "publish.Revenue", { type: "VIEW" })])
    const anchors = resolveGoalDataAnchors("use publish.Revenue", cat)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.resolution).toBe("mirror")
  })

  it("anchors globally-unique bare table names", () => {
    const cat = buildGraph([
      table("ai", "RevenueMart"),
      table("publish", "Sales"),
      table("publish", "Balances")
    ])
    const anchors = resolveGoalDataAnchors("short analysis on RevenueMart for q4 2025", cat)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.qualifiedName).toBe("ai.RevenueMart")
    expect(anchors[0]!.resolution).toBe("unique-name")
  })
})

describe("schemaMatchDetector — anchored goals", () => {
  const financeTenant: TenantConfig = {
    ...DEFAULT_TENANT_CONFIG,
    domainKeywords: ["financial", "revenue"]
  }

  it("does not ask to disambiguate 'financial' when goal pins ai.RevenueMart", () => {
    const cat = buildGraph([
      table("ai", "RevenueMart", { rowCount: 1_000_000 }),
      table("publish", "FinancialSummary"),
      table("core", "FinancialMetrics"),
      table("fact", "FinancialPositions"),
      table("dim", "FinancialCalendar")
    ])
    const goal =
      "create comprehensive, short, financial analysis based on uat ai.revenuMart data for q4 2025"
    const findings = schemaMatchDetector.detect(ctx({ goal, catalog: cat, tenant: financeTenant }))
    expect(findings).toEqual([])
  })

  it("still flags unrelated ambiguous nouns when a data anchor exists", () => {
    const cat = buildGraph([
      table("publish", "Revenue", { type: "VIEW" }),
      table("a", "Margin"),
      table("b", "MarginRaw")
    ])
    const findings = schemaMatchDetector.detect(
      ctx({ goal: "use publish.Revenue for margin", catalog: cat })
    )
    expect(findings.map((f) => f.subject)).toEqual(["margin"])
  })
})

describe("handleSearch — schema scoping during ranking", () => {
  it("returns in-schema hits even when global top-N would exclude them", () => {
    const cat = buildGraph([
      table("publish", "Revenue", { type: "VIEW", rowCount: 50_000_000 }),
      table("publish", "RevenueESGRules", { type: "VIEW", rowCount: 1_000_000 }),
      table("ai", "RevenueMart", { rowCount: 500_000 })
    ])
    const out = handleSearch(cat, "revenue", "ai")
    expect(out).toContain("ai.RevenueMart")
    expect(out).not.toContain("publish.Revenue")
  })
})
