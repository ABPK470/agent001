// Coreference-aware clarification tests.
//
// These tests pin the behaviour the user actually wants from a chat
// follow-up: after a substantive prior assistant turn, a pronoun-shaped
// goal ("plot it", "filter that") MUST NOT trigger a schema-match
// clarification, even when the goal text incidentally contains a token
// that matches multiple catalog identifiers. Without that guard, the
// agent re-asked "which one did you mean?" on every visualisation /
// filter follow-up.
//
// Companion: the LLM planner gate (`shouldInvokePlanner`) applies the
// same rule so we don't pay for an LLM call that will hallucinate a
// clarification at best.

import { describe, expect, it } from "vitest"

import { schemaMatchDetector } from "../../src/clarify/detectors/schema-match.js"
import { runLlmPlanner, shouldInvokePlanner } from "../../src/clarify/llm-planner.js"
import type { ClarifyContext } from "../../src/clarify/types.js"
import { MessageRole } from "../../src/domain/enums/message.js"
import { DEFAULT_TENANT_CONFIG } from "../../src/tenant/config.js"
import { CatalogGraph } from "../../src/tools/catalog/graph/index.js"
import type { CatalogColumn, CatalogTable } from "../../src/tools/catalog/types.js"
import type { LLMClient, Message } from "../../src/types.js"

function col(name: string, dataType = "int"): CatalogColumn {
  return { name, dataType, nullable: false, isPK: false, maxLength: null }
}
function table(schema: string, name: string, columns: CatalogColumn[]): CatalogTable {
  return {
    schema, name,
    qualifiedName: `${schema}.${name}`,
    type: "TABLE",
    rowCount: 1000,
    columns,
    fkOutgoing: [],
    fkIncoming: [],
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
    sysCatalog: [],
  } as Parameters<typeof CatalogGraph.fromSnapshot>[0])
}
function ctx(over: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    catalog: null,
    tenant: DEFAULT_TENANT_CONFIG,
    messages: [],
    resolved: [],
    round: 1,
    ...over,
  }
}

// Catalog where "revenue" is intentionally ambiguous so any goal mentioning
// it would normally fire schema-match. The coreference guard must override.
const ambiguousCatalog = catalogFrom([
  table("publish", "Revenue",    [col("amount", "decimal")]),
  table("core",    "RevenueRaw", [col("amount", "decimal")]),
  table("staging", "RevenueIn",  [col("amount", "decimal")]),
])

const PRIOR_USER: Message = {
  role: MessageRole.User,
  content: "select top 5 clients from publish.Revenue for January 2025",
}
const PRIOR_ASSISTANT: Message = {
  role: MessageRole.Assistant,
  content: "Here are the top 5 clients from publish.Revenue for January 2025: A=10, B=9, C=8, D=7, E=6.",
}

// ── schema-match coreference guard ──────────────────────────────

describe("schemaMatchDetector — coreference guard", () => {
  it("returns [] for a pronoun-shaped follow-up when a prior assistant turn exists", () => {
    // "for this data" contains the anaphora "this data"; "revenue" is mentioned
    // explicitly via the prior context but NOT in the new goal text. Without
    // the guard the detector would still latch onto any goal token that
    // happens to multi-match — this scenario covers the pure pronoun path.
    const findings = schemaMatchDetector.detect(ctx({
      goal: "ok can you create a nice visualization for this data",
      catalog: ambiguousCatalog,
      messages: [PRIOR_USER, PRIOR_ASSISTANT],
    }))
    expect(findings).toEqual([])
  })

  it("returns [] when goal says 'plot it' after a prior assistant turn", () => {
    const findings = schemaMatchDetector.detect(ctx({
      goal: "plot it as a bar chart",
      catalog: ambiguousCatalog,
      messages: [PRIOR_USER, PRIOR_ASSISTANT],
    }))
    expect(findings).toEqual([])
  })

  it("still fires when the goal contains an ambiguous noun and NO prior assistant turn exists", () => {
    // Same ambiguous catalog; first-turn goal with the multi-match noun.
    // The detector MUST still fire here — the guard only suppresses
    // pronoun follow-ups, not genuine first-turn ambiguities.
    const findings = schemaMatchDetector.detect(ctx({
      goal: "show top revenue",
      catalog: ambiguousCatalog,
      messages: [],
    }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("revenue")
  })

  it("still fires when goal has an ambiguous noun even if a prior assistant turn exists (no coreference shape)", () => {
    // Goal mentions "revenue" explicitly — there is no pronoun/anaphora,
    // so the guard does NOT apply and the detector should still warn.
    const findings = schemaMatchDetector.detect(ctx({
      goal: "show top revenue grouped by month",
      catalog: ambiguousCatalog,
      messages: [PRIOR_USER, PRIOR_ASSISTANT],
    }))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe("revenue")
  })

  it("ignores prior turns that are user-only (no assistant content)", () => {
    // Two consecutive user messages but no assistant turn — there is
    // nothing for the pronoun to refer to, so the detector must fire.
    const findings = schemaMatchDetector.detect(ctx({
      goal: "plot it as a bar chart for revenue",
      catalog: ambiguousCatalog,
      messages: [PRIOR_USER, { role: MessageRole.User, content: "and Africa only" }],
    }))
    expect(findings.length).toBeGreaterThan(0)
  })
})

// ── LLM-planner gate ────────────────────────────────────────────

describe("shouldInvokePlanner — coreference guard", () => {
  it("returns false for a pronoun-shaped goal with a prior assistant turn", () => {
    expect(shouldInvokePlanner(
      ctx({
        goal: "plot it as a chart for this data",
        catalog: ambiguousCatalog,
        messages: [PRIOR_USER, PRIOR_ASSISTANT],
      }),
      [],
    )).toBe(false)
  })

  it("returns true for a substantive first-turn goal", () => {
    expect(shouldInvokePlanner(
      ctx({
        goal: "show top revenue grouped by month",
        catalog: ambiguousCatalog,
        messages: [],
      }),
      [],
    )).toBe(true)
  })
})

// ── LLM-planner prompt: includes conversation preamble ──────────

describe("runLlmPlanner — conversation preamble", () => {
  it("includes a 'Recent conversation' preamble when ctx.messages is non-empty", async () => {
    let captured: Message[] = []
    const fake: LLMClient = {
      chat: async (messages) => {
        captured = messages as Message[]
        return { content: '{"findings": []}', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
      },
    } as unknown as LLMClient

    await runLlmPlanner(
      ctx({
        // Goal explicitly NOT coreferential so the gate would not skip it,
        // but we bypass the gate here by calling the planner directly.
        goal: "show top revenue grouped by month",
        catalog: ambiguousCatalog,
        messages: [PRIOR_USER, PRIOR_ASSISTANT],
      }),
      fake,
    )

    // User prompt is the second message (after the system prompt).
    const userPrompt = String(captured[1]?.content ?? "")
    expect(userPrompt).toContain("Recent conversation")
    expect(userPrompt).toContain("[user]")
    expect(userPrompt).toContain("[assistant]")
    expect(userPrompt).toContain("publish.Revenue")
  })

  it("omits the preamble when ctx.messages is empty", async () => {
    let captured: Message[] = []
    const fake: LLMClient = {
      chat: async (messages) => {
        captured = messages as Message[]
        return { content: '{"findings": []}', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
      },
    } as unknown as LLMClient

    await runLlmPlanner(
      ctx({
        goal: "show top revenue",
        catalog: ambiguousCatalog,
        messages: [],
      }),
      fake,
    )

    const userPrompt = String(captured[1]?.content ?? "")
    expect(userPrompt).not.toContain("Recent conversation")
  })
})
