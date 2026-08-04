// Unit tests for the LLM-planner fallback.
//
// Pure function tests — no live LLM. The shouldInvokePlanner gate is
// exercised across the gating axes; runLlmPlanner is driven by a fake
// LLMClient that returns canned content. parsePlannerResponse is also
// tested directly because the orchestrator will use it as the trust
// boundary between unstructured model text and structured findings.

import { describe, expect, it, vi } from "vitest"

import {
  parsePlannerResponse,
  runLlmPlanner,
  shouldInvokePlanner
} from "../../src/core/clarify/llm-planner.js"
import type {
  ClarifyContext,
  ResolvedClarification
} from "../../src/core/clarify/types.js"
import { DEFAULT_TENANT_CONFIG } from "../../src/domain/tenant/tenant-config.js"
import { CatalogGraph } from "../../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../../src/tools/catalog/types.js"
import type { LLMClient, LLMResponse, Message, Tool } from "../../src/domain/types/agent-types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, nullable: false, isPK: false, maxLength: null }
}

function table(schema: string, name: string, columns: CatalogColumn[]): CatalogTable {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount: 1000,
    columns,
    fkOutgoing: [],
    fkIncoming: []
  }
}

function catalogFrom(tables: CatalogTable[]): CatalogGraph {
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function minimalCatalog(): CatalogGraph {
  const tables: CatalogTable[] = [
    {
      schema: "publish",
      name: "Sales",
      qualifiedName: "publish.Sales",
      type: "TABLE",
      rowCount: 100,
      columns: [col("amount", "decimal")],
      fkOutgoing: [],
      fkIncoming: []
    }
  ]
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function dbCatalog(): CatalogGraph {
  const tables: CatalogTable[] = [
    {
      schema: "publish",
      name: "Revenue",
      qualifiedName: "publish.Revenue",
      type: "VIEW",
      rowCount: null,
      columns: [col("pkProduct"), col("pkMonth"), col("RevenueZARMTD", "decimal")],
      fkOutgoing: [],
      fkIncoming: []
    },
    {
      schema: "dim",
      name: "Product",
      qualifiedName: "dim.Product",
      type: "TABLE",
      rowCount: 4000,
      columns: [col("pkProduct"), col("Name", "nvarchar")],
      fkOutgoing: [],
      fkIncoming: []
    },
    {
      schema: "dim",
      name: "Date",
      qualifiedName: "dim.Date",
      type: "TABLE",
      rowCount: 55000,
      columns: [col("pkMonth"), col("Year")],
      fkOutgoing: [],
      fkIncoming: []
    }
  ]
  return CatalogGraph.fromSnapshot({
    version: 6,
    builtAt: new Date().toISOString(),
    source: "test",
    tables,
    implicitEdges: [],
    lineage: [],
    viewSourceRows: [],
    sysCatalog: []
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function ctx(over: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    catalog: minimalCatalog(),
    tenant: DEFAULT_TENANT_CONFIG,
    publishedSyncEntityIds: [],
    messages: [],
    resolved: [],
    round: 1,
    ...over
  }
}

function fakeClient(content: string | null, opts: { throws?: boolean } = {}): LLMClient {
  return {
    async chat(_m: Message[], _t: Tool[]): Promise<LLMResponse> {
      if (opts.throws) throw new Error("network down")
      return { content, toolCalls: [] }
    }
  }
}

// ── shouldInvokePlanner ─────────────────────────────────────────

describe("shouldInvokePlanner", () => {
  it("fires when all gates are open", () => {
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity" }), [])).toBe(true)
  })

  it("does not fire when detectors already produced findings", () => {
    const findings = [
      {
        id: "x",
        kind: "schema-match" as const,
        severity: "warn" as const,
        subject: "x",
        reasoning: "x",
        suggestedQuestion: "x",
        source: "detector" as const
      }
    ]
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity" }), findings)).toBe(false)
  })

  it("does not fire without a catalog", () => {
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity", catalog: null }), [])).toBe(false)
  })

  it("does not fire when clarifications already resolved", () => {
    const resolved: ResolvedClarification[] = [
      {
        findingId: "x",
        kind: "schema-match",
        subject: "x",
        question: "x",
        answer: "y",
        resolvedAtRound: 1
      }
    ]
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity", resolved }), [])).toBe(false)
  })

  it("does not fire past maxRound", () => {
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity", round: 5 }), [])).toBe(false)
  })

  it("does not fire on trivially short goals", () => {
    expect(shouldInvokePlanner(ctx({ goal: "hi" }), [])).toBe(false)
  })
})

// ── parsePlannerResponse ────────────────────────────────────────

describe("parsePlannerResponse", () => {
  it("parses a well-formed JSON response", () => {
    const json = JSON.stringify({
      findings: [
        {
          kind: "schema-match",
          severity: "block",
          subject: "revenue",
          reasoning: "Multiple matches",
          suggestedQuestion: "Which one?"
        }
      ]
    })
    const out = parsePlannerResponse(json)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(1)
    expect(out![0]!.kind).toBe("schema-match")
    expect(out![0]!.source).toBe("llm-planner")
    expect(out![0]!.id).toBe("schema-match:revenue")
  })

  it("strips ```json fences", () => {
    const fenced = "```json\n" + JSON.stringify({ findings: [] }) + "\n```"
    expect(parsePlannerResponse(fenced)).toEqual([])
  })

  it("returns null on invalid JSON", () => {
    expect(parsePlannerResponse("not json")).toBeNull()
  })

  it("returns null when findings is missing", () => {
    expect(parsePlannerResponse(JSON.stringify({}))).toBeNull()
  })

  it("drops findings with invalid kind", () => {
    const json = JSON.stringify({
      findings: [{ kind: "bogus", severity: "block", subject: "x", reasoning: "x", suggestedQuestion: "x" }]
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })

  it("drops findings with invalid severity", () => {
    const json = JSON.stringify({
      findings: [
        {
          kind: "schema-match",
          severity: "fatal",
          subject: "x",
          reasoning: "x",
          suggestedQuestion: "x"
        }
      ]
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })

  it("drops findings with missing fields", () => {
    const json = JSON.stringify({
      findings: [{ kind: "schema-match", severity: "block", subject: "x" }]
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })
})

// ── runLlmPlanner ───────────────────────────────────────────────

describe("runLlmPlanner", () => {
  it("returns parsed findings on success", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "Foo",
            reasoning: "no match",
            suggestedQuestion: "What is Foo?"
          }
        ]
      })
    )
    const out = await runLlmPlanner(ctx({ goal: "show Foo stuff" }), client)
    expect(out).toHaveLength(1)
    expect(out[0]!.source).toBe("llm-planner")
  })

  it("returns [] on null content", async () => {
    expect(await runLlmPlanner(ctx({ goal: "show stuff" }), fakeClient(null))).toEqual([])
  })

  it("returns [] on invalid JSON without throwing", async () => {
    expect(await runLlmPlanner(ctx({ goal: "show stuff" }), fakeClient("not json"))).toEqual([])
  })

  it("returns [] (does not throw) when the client throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await runLlmPlanner(ctx({ goal: "show stuff" }), fakeClient(null, { throws: true }))).toEqual([])
    warn.mockRestore()
  })

  it("respects maxFindings cap", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      kind: "term-undefined",
      severity: "block",
      subject: `Term${i}`,
      reasoning: "x",
      suggestedQuestion: "x"
    }))
    const client = fakeClient(JSON.stringify({ findings: many }))
    const out = await runLlmPlanner(ctx({ goal: "show stuff" }), client, { maxFindings: 3 })
    expect(out).toHaveLength(3)
  })

  it("filters object-confirmation findings when schema-qualified objects already resolve in the catalog", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "schema-match",
            severity: "block",
            subject: "publish.Revenue, dim.Product, and dim.Date",
            reasoning: "Need to verify the objects first.",
            suggestedQuestion:
              "Can you confirm that publish.Revenue, dim.Product, and dim.Date exist in this database and share their relevant columns or a catalog entry for them?"
          }
        ]
      })
    )

    const out = await runLlmPlanner(
      ctx({
        goal: "Use publish.Revenue, dim.Product, and dim.Date. Rank the top 10 rows by RevenueZARMTD where d.Year = 2025, and return a compact table.",
        catalog: dbCatalog()
      }),
      client
    )

    expect(out).toEqual([])
  })

  it("filters term-undefined object-confirmation findings when the goal already names resolvable schema-qualified objects", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "publish.Revenue, dim.Product, and dim.Date",
            reasoning: "The objects are not in the sample.",
            suggestedQuestion:
              "I can't find publish.Revenue, dim.Product, or dim.Date in the catalog sample-can you confirm the exact table/view names or provide a catalog sample that includes them?"
          }
        ]
      })
    )

    const out = await runLlmPlanner(
      ctx({
        goal: "Use publish.Revenue, dim.Product, and dim.Date. Rank the top 10 rows by RevenueZARMTD where d.Year = 2025, and return a compact table.",
        catalog: dbCatalog()
      }),
      client
    )

    expect(out).toEqual([])
  })

  it("filters metric-confirmation findings when the goal already names an exact numeric catalog column", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "metric-undefined",
            severity: "block",
            subject: "RevenueZARMTD",
            reasoning: "The metric may not exist.",
            suggestedQuestion:
              "Is RevenueZARMTD an actual column in publish.Revenue, and if so what is its exact name?"
          }
        ]
      })
    )

    const out = await runLlmPlanner(
      ctx({
        goal: "Use publish.Revenue, dim.Product, and dim.Date. Rank the top 10 rows by RevenueZARMTD where d.Year = 2025, and return a compact table.",
        catalog: dbCatalog()
      }),
      client
    )

    expect(out).toEqual([])
  })

  it("filters output-format findings when the goal already asks for a compact table", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "output-format",
            severity: "warn",
            subject: "top 10 rows",
            reasoning: "The display columns are unclear.",
            suggestedQuestion: "Which columns should be shown in the compact table for the top 10 results?"
          }
        ]
      })
    )

    const out = await runLlmPlanner(
      ctx({
        goal: "Use publish.Revenue, dim.Product, and dim.Date. Rank the top 10 rows by RevenueZARMTD where d.Year = 2025, and return a compact markdown table.",
        catalog: dbCatalog()
      }),
      client
    )

    expect(out).toEqual([])
  })

  it("filters grain-undefined findings when the goal already names one clear non-temporal row entity", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "grain-undefined",
            severity: "block",
            subject: "top 10 rows",
            reasoning: "The row grain is unclear.",
            suggestedQuestion:
              "Which columns should define each ranked row in the compact table (for example, product, month, or another field)?"
          }
        ]
      })
    )

    const out = await runLlmPlanner(
      ctx({
        goal: "Use publish.Revenue, dim.Product, and dim.Date. Rank the top 10 rows by RevenueZARMTD where d.Year = 2025, and return a compact table.",
        catalog: dbCatalog()
      }),
      client
    )

    expect(out).toEqual([])
  })

  it("drops a hallucinated 'which database' finding — a live catalog already answers it", async () => {
    // Regression (2026-08-04): the planner asked "what is the exact database
    // name for mymi" even though a catalog was already connected and built
    // for one specific, resolved database. The prompt now instructs against
    // this, but the deterministic filter is the hard guarantee.
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "mymi database",
            reasoning: "The catalog does not show a database named mymi.",
            suggestedQuestion: "What is the exact database name for \"mymi\"?"
          }
        ]
      })
    )
    const out = await runLlmPlanner(ctx({ goal: "how many tables in mymi database" }), client)
    expect(out).toEqual([])
  })

  it("drops a hallucinated 'which environment' finding — a live catalog already answers it", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "DEV env",
            reasoning: "No environment identifier is visible in the catalog sample.",
            suggestedQuestion: "How is the DEV environment identified?"
          }
        ]
      })
    )
    const out = await runLlmPlanner(ctx({ goal: "use DEV env and core schema" }), client)
    expect(out).toEqual([])
  })

  it("drops a hallucinated 'which schema' finding when the schema genuinely exists in the catalog", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "core schema",
            reasoning: "Nothing in the sample confirms which schema is core.",
            suggestedQuestion: "Which schema do you mean by \"core schema\"?"
          }
        ]
      })
    )
    // dbCatalog() only contains publish/dim tables — swap in one with a
    // "core" schema so the filter has something real to confirm against.
    const catalogWithCore = catalogFrom([table("core", "Dataset", [col("datasetId")])])
    const out = await runLlmPlanner(ctx({ goal: "how many core schema tables", catalog: catalogWithCore }), client)
    expect(out).toEqual([])
  })

  it("keeps a genuine term-undefined finding whose subject is not a schema/env/database word", async () => {
    const client = fakeClient(
      JSON.stringify({
        findings: [
          {
            kind: "term-undefined",
            severity: "block",
            subject: "Widget Velocity",
            reasoning: "No catalog object matches this phrase.",
            suggestedQuestion: "What does \"Widget Velocity\" refer to?"
          }
        ]
      })
    )
    const out = await runLlmPlanner(ctx({ goal: "show Widget Velocity" }), client)
    expect(out).toHaveLength(1)
    expect(out[0]!.subject).toBe("Widget Velocity")
  })

  it("lists every catalog schema name in the prompt, not just the sampled slice", async () => {
    let captured: Message[] = []
    const client: LLMClient = {
      chat: async (messages) => {
        captured = messages as Message[]
        return { content: '{"findings": []}', toolCalls: [] }
      }
    } as unknown as LLMClient
    const catalogWithCore = catalogFrom([
      table("publish", "Sales", [col("amount", "decimal")]),
      table("core", "Dataset", [col("datasetId")])
    ])
    await runLlmPlanner(ctx({ goal: "how many core schema tables", catalog: catalogWithCore }), client, {
      catalogSampleSize: 1
    })
    const userPrompt = String(captured[1]?.content ?? "")
    expect(userPrompt).toContain("Known schemas")
    expect(userPrompt).toContain("core")
    expect(userPrompt).toContain("publish")
  })
})
