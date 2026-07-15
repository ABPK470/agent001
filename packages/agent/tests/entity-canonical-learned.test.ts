/**
 * Learned term→table mappings (durable clarification answers) suppress the
 * canonical-resolution path and the schema-match detector, so a subject the
 * org already resolved does not re-trigger `ask_user` on the next run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  isCanonicallyGroundedEntity,
  resolveCanonicalEntityTable
} from "../src/application/core/clarify-cluster/entity-canonical.js"
import { schemaMatchDetector } from "../src/application/core/clarify-cluster/detectors/schema-match.js"
import type { ClarifyContext } from "../src/application/core/clarify-cluster/types.js"
import {
  getTenantConfig,
  resetTenantConfig,
  setTenantConfig
} from "../src/application/shell/tenant-config.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, nullable: false, isPK: false, maxLength: null }
}
function tbl(schema: string, name: string, columns: CatalogColumn[]): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount: null,
    columns,
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

// Two tables whose object names both match the token "clients" → schema-match
// would normally BLOCK without a learned mapping.
const dimClient = tbl("dim", "Client", [col("pkClient"), col("ClientName", "nvarchar")])
const archiveClient = tbl("archive", "Client", [col("pkClient"), col("ClientName", "nvarchar")])
const catalog = buildGraph([dimClient, archiveClient])

beforeEach(() => {
  resetTenantConfig()
  // No static canonical mapping for "clients" — the learned map is the only
  // path that can suppress the detector here.
  setTenantConfig({ domainKeywords: [] })
})
afterEach(() => resetTenantConfig())

function makeCtx(learned: Map<string, string> | undefined, goal: string): ClarifyContext {
  return {
    goal,
    catalog,
    tenant: getTenantConfig(),
    messages: [],
    resolved: [],
    round: 1,
    ...(learned ? { learnedTermMappings: learned } : {})
  }
}

describe("entity-canonical — learned mappings", () => {
  it("resolveCanonicalEntityTable returns the learned qname when it resolves in the catalog", () => {
    const learned = new Map([["clients", "dim.Client"]])
    expect(resolveCanonicalEntityTable("clients", catalog, getTenantConfig(), learned)).toBe("dim.Client")
  })

  it("isCanonicallyGroundedEntity is true for a learned term", () => {
    const learned = new Map([["clients", "dim.Client"]])
    expect(isCanonicallyGroundedEntity("clients", catalog, getTenantConfig(), learned)).toBe(true)
  })

  it("a learned mapping whose qname no longer exists in the catalog is ignored (stale auto-expire)", () => {
    const learned = new Map([["clients", "dim.Gone"]])
    expect(resolveCanonicalEntityTable("clients", catalog, getTenantConfig(), learned)).toBeNull()
  })

  it("learned mappings take priority over static tenant canonicalQualifiedNames", () => {
    setTenantConfig({
      domainKeywords: [],
      catalogBootstrap: { canonicalQualifiedNames: { clients: "archive.Client" } }
    })
    const learned = new Map([["clients", "dim.Client"]])
    expect(resolveCanonicalEntityTable("clients", catalog, getTenantConfig(), learned)).toBe("dim.Client")
  })

  it("tolerates singular/plural drift — learned 'product' suppresses 'products' and vice-versa", () => {
    const dimProduct = tbl("dim", "Product", [col("pkProduct"), col("ProductName", "nvarchar")])
    const archiveProduct = tbl("archive", "Product", [col("pkProduct"), col("ProductName", "nvarchar")])
    const cat = buildGraph([dimProduct, archiveProduct])

    const learnedSingular = new Map([["product", "dim.Product"]])
    expect(resolveCanonicalEntityTable("products", cat, getTenantConfig(), learnedSingular)).toBe("dim.Product")

    const learnedPlural = new Map([["products", "dim.Product"]])
    expect(resolveCanonicalEntityTable("product", cat, getTenantConfig(), learnedPlural)).toBe("dim.Product")
  })
})

describe("schema-match detector — learned suppression", () => {
  it("BLOCKS on a multi-match noun when no learned mapping is present", () => {
    const ctx = makeCtx(undefined, "top 5 clients by revenue")
    const findings = schemaMatchDetector.detect(ctx)
    const clientFinding = findings.find((f) => f.subject.toLowerCase() === "clients")
    expect(clientFinding).toBeDefined()
    expect(clientFinding!.severity).toBe("block")
  })

  it("SUPPRESSES the block when a learned mapping resolves the term", () => {
    const learned = new Map([["clients", "dim.Client"]])
    const ctx = makeCtx(learned, "top 5 clients by revenue")
    const findings = schemaMatchDetector.detect(ctx)
    expect(findings.find((f) => f.subject.toLowerCase() === "clients")).toBeUndefined()
  })

  it("does not suppress when the learned qname is no longer in the catalog", () => {
    const learned = new Map([["clients", "dim.Gone"]])
    const ctx = makeCtx(learned, "top 5 clients by revenue")
    const findings = schemaMatchDetector.detect(ctx)
    expect(findings.find((f) => f.subject.toLowerCase() === "clients")).toBeDefined()
  })
})
