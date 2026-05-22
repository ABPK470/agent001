// Unit tests for the LLM-planner fallback.
//
// Pure function tests — no live LLM. The shouldInvokePlanner gate is
// exercised across the gating axes; runLlmPlanner is driven by a fake
// LLMClient that returns canned content. parsePlannerResponse is also
// tested directly because the orchestrator will use it as the trust
// boundary between unstructured model text and structured findings.

import { describe, expect, it, vi } from "vitest"

import { parsePlannerResponse, runLlmPlanner, shouldInvokePlanner } from "../../src/clarify/llm-planner.js"
import type { ClarifyContext, ResolvedClarification } from "../../src/clarify/types.js"
import { DEFAULT_TENANT_CONFIG } from "../../src/tenant/config.js"
import { CatalogGraph } from "../../src/tools/catalog/graph/index.js"
import type { CatalogTable } from "../../src/tools/catalog/types.js"
import type { LLMClient, LLMResponse, Message, Tool } from "../../src/types.js"

function minimalCatalog(): CatalogGraph {
  const tables: CatalogTable[] = [
    { schema: "publish", name: "Sales", qualifiedName: "publish.Sales", type: "TABLE", rowCount: 100,
      columns: [{ name: "amount", dataType: "decimal", nullable: false, isPK: false, maxLength: null }],
      fkOutgoing: [], fkIncoming: [] },
  ]
  return CatalogGraph.fromSnapshot({
    version: 6, builtAt: new Date().toISOString(), source: "test",
    tables, implicitEdges: [], lineage: [], viewSourceRows: [], sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}

function ctx(over: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    catalog: minimalCatalog(),
    tenant: DEFAULT_TENANT_CONFIG,
    messages: [],
    resolved: [],
    round: 1,
    ...over,
  }
}

function fakeClient(content: string | null, opts: { throws?: boolean } = {}): LLMClient {
  return {
    async chat(_m: Message[], _t: Tool[]): Promise<LLMResponse> {
      if (opts.throws) throw new Error("network down")
      return { content, toolCalls: [] }
    },
  }
}

// ── shouldInvokePlanner ─────────────────────────────────────────

describe("shouldInvokePlanner", () => {
  it("fires when all gates are open", () => {
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity" }), [])).toBe(true)
  })

  it("does not fire when detectors already produced findings", () => {
    const findings = [{
      id: "x", kind: "schema-match" as const, severity: "warn" as const,
      subject: "x", reasoning: "x", suggestedQuestion: "x", source: "detector" as const,
    }]
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity" }), findings)).toBe(false)
  })

  it("does not fire without a catalog", () => {
    expect(shouldInvokePlanner(ctx({ goal: "show me sales activity", catalog: null }), [])).toBe(false)
  })

  it("does not fire when clarifications already resolved", () => {
    const resolved: ResolvedClarification[] = [{
      findingId: "x", kind: "schema-match", subject: "x",
      question: "x", answer: "y", resolvedAtRound: 1,
    }]
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
      findings: [{
        kind: "schema-match", severity: "block", subject: "revenue",
        reasoning: "Multiple matches", suggestedQuestion: "Which one?",
      }],
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
      findings: [{ kind: "bogus", severity: "block", subject: "x", reasoning: "x", suggestedQuestion: "x" }],
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })

  it("drops findings with invalid severity", () => {
    const json = JSON.stringify({
      findings: [{ kind: "schema-match", severity: "fatal", subject: "x", reasoning: "x", suggestedQuestion: "x" }],
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })

  it("drops findings with missing fields", () => {
    const json = JSON.stringify({
      findings: [{ kind: "schema-match", severity: "block", subject: "x" }],
    })
    expect(parsePlannerResponse(json)).toEqual([])
  })
})

// ── runLlmPlanner ───────────────────────────────────────────────

describe("runLlmPlanner", () => {
  it("returns parsed findings on success", async () => {
    const client = fakeClient(JSON.stringify({
      findings: [{
        kind: "term-undefined", severity: "block", subject: "Foo",
        reasoning: "no match", suggestedQuestion: "What is Foo?",
      }],
    }))
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
      kind: "term-undefined", severity: "block",
      subject: `Term${i}`, reasoning: "x", suggestedQuestion: "x",
    }))
    const client = fakeClient(JSON.stringify({ findings: many }))
    const out = await runLlmPlanner(ctx({ goal: "show stuff" }), client, { maxFindings: 3 })
    expect(out).toHaveLength(3)
  })
})
