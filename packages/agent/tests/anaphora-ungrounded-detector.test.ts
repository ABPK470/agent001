/**
 * Tests for the `anaphora-ungrounded` clarifier (no-amnesia, runtime
 * enforcement counterpart of the `<prior_results>` system_anchor).
 *
 * Detector contract:
 *   • fires WARN when goal is co-referential ∧ a prior assistant turn
 *     exists ∧ `ctx.priorResultsCount === 0`;
 *   • silent when any one of those is false;
 *   • silent when `priorResultsCount` is absent (CLI / test contexts
 *     where the orchestrator isn't in scope at all).
 *
 * Holds the line on: "do not paraphrase prior prose as evidence — the
 * 22-May-2026 fabricated-chart-numbers incident".
 */
import { describe, expect, it } from "vitest"
import { anaphoraUngroundedDetector } from "../src/application/core/clarify-cluster/detectors/anaphora-ungrounded.js"
import type { ClarifyContext } from "../src/application/core/clarify-cluster/types.js"
import type { TenantConfig } from "../src/application/shell/tenant-config.js"
import { MessageRole } from "../src/domain/enums/message.js"

const TENANT: TenantConfig = {
  routingKeywords: { schemas: [], domain: [], sync: [] },
} as unknown as TenantConfig

function ctx(over: Partial<ClarifyContext> & Pick<ClarifyContext, "goal">): ClarifyContext {
  return {
    goal: over.goal,
    catalog: over.catalog ?? null,
    tenant: over.tenant ?? TENANT,
    messages: over.messages ?? [],
    resolved: over.resolved ?? [],
    round: over.round ?? 2,
    priorResultsCount: over.priorResultsCount,
  }
}

const assistantTurn = { role: MessageRole.Assistant, content: "Top 5 clients: A=10, B=9, C=8, D=7, E=6." } as const

describe("anaphora-ungrounded detector", () => {
  it("does NOT fire when priorResultsCount is undefined (CLI / no orchestrator)", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "now plot it as a bar chart",
      messages: [assistantTurn],
    }))
    expect(f).toEqual([])
  })

  it("does NOT fire on a fresh (non-coreferential) goal", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "show total revenue for 2025",
      messages: [assistantTurn],
      priorResultsCount: 0,
    }))
    expect(f).toEqual([])
  })

  it("does NOT fire when no prior assistant turn exists (first turn)", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "filter that to Africa only",
      messages: [],
      priorResultsCount: 0,
    }))
    expect(f).toEqual([])
  })

  it("does NOT fire when prior_results has at least one entry (grounded path)", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "plot it as a bar chart",
      messages: [assistantTurn],
      priorResultsCount: 1,
    }))
    expect(f).toEqual([])
  })

  it("FIRES warn when goal is coreferential, prior turn exists, prior_results is empty", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "now plot those clients on a pie chart",
      messages: [assistantTurn],
      priorResultsCount: 0,
    }))
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe("anaphora-ungrounded")
    expect(f[0]!.severity).toBe("warn")
    expect(f[0]!.source).toBe("detector")
    expect(f[0]!.id).toMatch(/^anaphora-ungrounded:/)
    expect(f[0]!.reasoning).toMatch(/no structured tool payload/i)
    expect(f[0]!.suggestedQuestion).toMatch(/re-run|point me/i)
  })

  it("recognises a range of anaphoric triggers", () => {
    const triggers = ["plot it", "filter those", "and that one too", "summarise the data", "export the result", "show the chart again"]
    for (const goal of triggers) {
      const f = anaphoraUngroundedDetector.detect(ctx({
        goal, messages: [assistantTurn], priorResultsCount: 0,
      }))
      expect(f, `expected ${JSON.stringify(goal)} to fire`).toHaveLength(1)
    }
  })

  it("ignores empty-content assistant turns when scanning for a prior turn", () => {
    const f = anaphoraUngroundedDetector.detect(ctx({
      goal: "plot it",
      messages: [{ role: MessageRole.Assistant, content: "   " }],
      priorResultsCount: 0,
    }))
    expect(f).toEqual([])
  })
})
