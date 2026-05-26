/**
 * Plan v3 Phase 4 — memory-verdict bonus in `searchCatalog`.
 *
 * Verifies the rank-time read-back: durable `table_verdict` records
 * stored by prior runs (semantic memory) bias current ranking via the
 * explicit `TableVerdictsReader`. Magnitudes:
 *   canonical → +200, subset → −150, rules → −120, staging → −80,
 *   archive → −60, unknown → 0.
 *
 * The reader is stubbed per-test (real binding lives in the server's
 * run-executor host wiring) so this exercise is hermetic — no DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetTenantConfig } from "../src/application/shell/tenant-config.js"
import type { TableVerdictRecord, TableVerdictsReader } from "../src/host/index.js"
import { CatalogGraph } from "../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../src/tools/catalog/types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, maxLength: null, nullable: false, isPK: false }
}

function table(schema: string, name: string, opts: {
  type?: "TABLE" | "VIEW"
  rowCount?: number | null
  columns?: CatalogColumn[]
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
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function stubVerdicts(records: TableVerdictRecord[]): TableVerdictsReader {
  return {
    list: ({ qnames }) => {
    const wanted = new Set(qnames.map((q) => q.toLowerCase()))
    return records.filter((r) => wanted.has(r.qname.toLowerCase()))
    },
  }
}

function rec(qname: string, role: TableVerdictRecord["role"]): TableVerdictRecord {
  return {
    qname,
    role,
    evidence: [`stub: ${role}`],
    confidence: 0.9,
    createdAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  resetTenantConfig()
})
afterEach(() => {
  resetTenantConfig()
})

describe("searchCatalog — memory verdict bonus", () => {
  it("does nothing when the runtime callback is unbound", () => {
    const a = table("publish", "Revenue")
    const b = table("publish", "RevenueESGRules")
    const g = buildGraph([a, b])
    const hits = g.search("revenue", 10, null)
    expect(hits).toHaveLength(2)
    // No crash; ranking unchanged from structural-only behaviour.
  })

  it("boosts a 'canonical' verdict above an unmarked sibling", () => {
    const canon = table("publish", "Revenue")
    const sibling = table("publish", "RevenueB")
    const g = buildGraph([canon, sibling])
    // Without the bonus, RevenueB would tie/win on bare-cluster (or be
    // equal on nameScore). Verdict tips it to canon.
    const verdicts = stubVerdicts([rec("publish.Revenue", "canonical")])
    const hits = g.search("revenue", 10, verdicts)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })

  it("penalises a 'subset' verdict below an unmarked sibling", () => {
    const canon = table("publish", "Revenue")
    const subset = table("publish", "RevenueESGRules")
    const g = buildGraph([canon, subset])
    const verdicts = stubVerdicts([rec("publish.RevenueESGRules", "subset")])
    const hits = g.search("revenue", 10, verdicts)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    expect(hits[hits.length - 1]?.table.qualifiedName).toBe("publish.RevenueESGRules")
  })

  it("flips ranking when canonical + subset verdicts coexist", () => {
    // Two equally-named matches — the canonical wins by +350 swing.
    const a = table("publish", "RevenueA")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    const verdicts = stubVerdicts([
      rec("publish.RevenueA", "subset"),
      rec("publish.RevenueB", "canonical"),
    ])
    const hits = g.search("revenue", 10, verdicts)
    expect(hits[0]?.table.qualifiedName).toBe("publish.RevenueB")
    expect(hits[1]?.table.qualifiedName).toBe("publish.RevenueA")
  })

  it("ignores 'unknown' verdicts (zero bonus)", () => {
    const a = table("publish", "RevenueA")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    const verdicts = stubVerdicts([rec("publish.RevenueA", "unknown")])
    const hits = g.search("revenue", 10, verdicts)
    // Order is whatever structural ranking decides — verdict didn't move it.
    expect(hits.map((h) => h.table.qualifiedName).sort()).toEqual([
      "publish.RevenueA", "publish.RevenueB",
    ])
  })

  it("matches qname case-insensitively", () => {
    const t = table("publish", "Revenue")
    const sibling = table("publish", "RevenueB")
    const g = buildGraph([t, sibling])
    const verdicts = stubVerdicts([rec("PUBLISH.revenue", "canonical")])
    const hits = g.search("revenue", 10, verdicts)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })

  it("survives a throwing callback (no crash, no boost applied)", () => {
    const a = table("publish", "Revenue")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    const hits = g.search("revenue", 10, { list: () => { throw new Error("boom") } })
    expect(hits).toHaveLength(2)
  })

  it("applies penalties for 'staging', 'archive', 'rules'", () => {
    const canon = table("publish", "Revenue")
    const stage = table("publish", "RevenueStage")
    const arch = table("publish", "RevenueArchive")
    const rules = table("publish", "RevenueRules")
    const g = buildGraph([canon, stage, arch, rules])
    const verdicts = stubVerdicts([
      rec("publish.RevenueStage", "staging"),
      rec("publish.RevenueArchive", "archive"),
      rec("publish.RevenueRules", "rules"),
    ])
    const hits = g.search("revenue", 10, verdicts)
    // canon should be first; rules penalty (−120) is harshest among siblings.
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    expect(hits[hits.length - 1]?.table.qualifiedName).toBe("publish.RevenueRules")
  })
})
