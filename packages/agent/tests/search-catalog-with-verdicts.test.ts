/**
 * Plan v3 Phase 4 — memory-verdict bonus in `searchCatalog`.
 *
 * Verifies the rank-time read-back: durable `table_verdict` records
 * stored by prior runs (semantic memory) bias current ranking via the
 * `AgentRuntime.tableVerdicts.list` callback. Magnitudes:
 *   canonical → +200, subset → −150, rules → −120, staging → −80,
 *   archive → −60, unknown → 0.
 *
 * The callback is stubbed per-test (real binding lives in the server's
 * run-executor) so this exercise is hermetic — no DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AgentRuntime, type TableVerdictRecord } from "../src/agent-runtime.js"
import { resetTenantConfig } from "../src/tenant/config.js"
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

function stubVerdicts(records: TableVerdictRecord[]): void {
  AgentRuntime.root().tableVerdicts.list = ({ qnames }) => {
    const wanted = new Set(qnames.map((q) => q.toLowerCase()))
    return records.filter((r) => wanted.has(r.qname.toLowerCase()))
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
  // Default unbound — individual tests opt in via stubVerdicts.
  AgentRuntime.root().tableVerdicts.list = null
})
afterEach(() => {
  resetTenantConfig()
  AgentRuntime.root().tableVerdicts.list = null
})

describe("searchCatalog — memory verdict bonus", () => {
  it("does nothing when the runtime callback is unbound", () => {
    const a = table("publish", "Revenue")
    const b = table("publish", "RevenueESGRules")
    const g = buildGraph([a, b])
    const hits = g.search("revenue", 10)
    expect(hits).toHaveLength(2)
    // No crash; ranking unchanged from structural-only behaviour.
  })

  it("boosts a 'canonical' verdict above an unmarked sibling", () => {
    const canon = table("publish", "Revenue")
    const sibling = table("publish", "RevenueB")
    const g = buildGraph([canon, sibling])
    // Without the bonus, RevenueB would tie/win on bare-cluster (or be
    // equal on nameScore). Verdict tips it to canon.
    stubVerdicts([rec("publish.Revenue", "canonical")])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })

  it("penalises a 'subset' verdict below an unmarked sibling", () => {
    const canon = table("publish", "Revenue")
    const subset = table("publish", "RevenueESGRules")
    const g = buildGraph([canon, subset])
    stubVerdicts([rec("publish.RevenueESGRules", "subset")])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    expect(hits[hits.length - 1]?.table.qualifiedName).toBe("publish.RevenueESGRules")
  })

  it("flips ranking when canonical + subset verdicts coexist", () => {
    // Two equally-named matches — the canonical wins by +350 swing.
    const a = table("publish", "RevenueA")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    stubVerdicts([
      rec("publish.RevenueA", "subset"),
      rec("publish.RevenueB", "canonical"),
    ])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.RevenueB")
    expect(hits[1]?.table.qualifiedName).toBe("publish.RevenueA")
  })

  it("ignores 'unknown' verdicts (zero bonus)", () => {
    const a = table("publish", "RevenueA")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    stubVerdicts([rec("publish.RevenueA", "unknown")])
    const hits = g.search("revenue", 10)
    // Order is whatever structural ranking decides — verdict didn't move it.
    expect(hits.map((h) => h.table.qualifiedName).sort()).toEqual([
      "publish.RevenueA", "publish.RevenueB",
    ])
  })

  it("matches qname case-insensitively", () => {
    const t = table("publish", "Revenue")
    const sibling = table("publish", "RevenueB")
    const g = buildGraph([t, sibling])
    stubVerdicts([rec("PUBLISH.revenue", "canonical")])
    const hits = g.search("revenue", 10)
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
  })

  it("survives a throwing callback (no crash, no boost applied)", () => {
    const a = table("publish", "Revenue")
    const b = table("publish", "RevenueB")
    const g = buildGraph([a, b])
    AgentRuntime.root().tableVerdicts.list = () => { throw new Error("boom") }
    const hits = g.search("revenue", 10)
    expect(hits).toHaveLength(2)
  })

  it("applies penalties for 'staging', 'archive', 'rules'", () => {
    const canon = table("publish", "Revenue")
    const stage = table("publish", "RevenueStage")
    const arch = table("publish", "RevenueArchive")
    const rules = table("publish", "RevenueRules")
    const g = buildGraph([canon, stage, arch, rules])
    stubVerdicts([
      rec("publish.RevenueStage", "staging"),
      rec("publish.RevenueArchive", "archive"),
      rec("publish.RevenueRules", "rules"),
    ])
    const hits = g.search("revenue", 10)
    // canon should be first; rules penalty (−120) is harshest among siblings.
    expect(hits[0]?.table.qualifiedName).toBe("publish.Revenue")
    expect(hits[hits.length - 1]?.table.qualifiedName).toBe("publish.RevenueRules")
  })
})
