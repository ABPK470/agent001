/**
 * Answer-stability completion override (Phase 4).
 *
 * Two structurally-identical no-tool-call iterations in a row ⇒ accept
 * the answer and bypass downstream guards. The structural signature is
 * (tableRowCount, sectionCount, length); prose wording is ignored.
 */
import { describe, expect, it } from "vitest"

import {
  checkAnswerStability,
  computeAnswerSignature,
  type LoopPolicyContext
} from "../src/application/shell/loop-cluster/loop-policy/index.js"
import { createAgentLoopState } from "../src/application/shell/loop-cluster/state.js"

const ANSWER_WITH_TABLE = [
  "## Top clients",
  "",
  "| Client | Revenue |",
  "| --- | --- |",
  "| Acme | 100 |",
  "| Beta | 90 |",
  "",
  "## Recommendation",
  "",
  "The next step is to renew Acme's contract before EOQ."
].join("\n")

function makeCtx(overrides: Partial<LoopPolicyContext> = {}): LoopPolicyContext {
  const state = createAgentLoopState(30)
  return {
    iteration: 5,
    userGoal: "Summarize top clients",
    messages: [],
    state,
    toolList: [],
    availableToolNames: [],
    response: { content: ANSWER_WITH_TABLE, toolCalls: [] },
    config: {
      maxIterations: 30,
      enablePlanner: false,
      plannerDelegateFn: undefined,
      completionValidator: undefined,
      verbose: false,
      enableAnswerStabilityGuard: true
    },
    onPlannerTrace: undefined,
    ...overrides
  }
}

describe("computeAnswerSignature", () => {
  it("returns null when the answer has no table", () => {
    expect(computeAnswerSignature("## Just a header\n\nNo table here.")).toBeNull()
  })

  it("returns null when the answer has no section header", () => {
    expect(computeAnswerSignature("| a | b |\n| - | - |\n| 1 | 2 |")).toBeNull()
  })

  it("returns null when the answer has no conclusion keyword", () => {
    const noConclusion = ANSWER_WITH_TABLE.replace(/Recommendation/, "Details").replace(
      /next step/,
      "more data"
    )
    expect(computeAnswerSignature(noConclusion)).toBeNull()
  })

  it("counts table rows excluding the separator line", () => {
    const sig = computeAnswerSignature(ANSWER_WITH_TABLE)
    // Header row + 2 data rows = 3 rows; separator (|---|---|) excluded.
    expect(sig?.tableRowCount).toBe(3)
    expect(sig?.sectionCount).toBe(2)
  })
})

describe("checkAnswerStability", () => {
  it("does not fire on the first eligible answer (no prior signature)", () => {
    const ctx = makeCtx()
    expect(checkAnswerStability(ctx)).toBe(false)
    expect(ctx.state.lastAnswerSignature).toBeDefined()
  })

  it("fires when two consecutive responses have the same signature", () => {
    const ctx = makeCtx()
    expect(checkAnswerStability(ctx)).toBe(false)
    // Second call with same content
    expect(checkAnswerStability(ctx)).toBe(true)
  })

  it("does NOT fire when the signature changes (e.g. table grew)", () => {
    const ctx = makeCtx()
    expect(checkAnswerStability(ctx)).toBe(false)
    const grown = ANSWER_WITH_TABLE.replace("| Beta | 90 |", "| Beta | 90 |\n| Gamma | 80 |")
    const ctx2 = { ...ctx, response: { content: grown, toolCalls: [] } }
    expect(checkAnswerStability(ctx2)).toBe(false)
  })

  it("resets the signature when the response has tool calls", () => {
    const ctx = makeCtx()
    expect(checkAnswerStability(ctx)).toBe(false)
    const withTool = { ...ctx, response: { content: ANSWER_WITH_TABLE, toolCalls: [{}] } }
    expect(checkAnswerStability(withTool)).toBe(false)
    expect(withTool.state.lastAnswerSignature).toBeUndefined()
  })

  it("does not fire when the answer is too thin (no table / header / conclusion)", () => {
    const ctx = makeCtx({ response: { content: "Done.", toolCalls: [] } })
    expect(checkAnswerStability(ctx)).toBe(false)
    expect(checkAnswerStability(ctx)).toBe(false)
  })

  it("respects the disable flag", () => {
    const ctx = makeCtx({
      config: {
        maxIterations: 30,
        enablePlanner: false,
        plannerDelegateFn: undefined,
        completionValidator: undefined,
        verbose: false,
        enableAnswerStabilityGuard: false
      }
    })
    expect(checkAnswerStability(ctx)).toBe(false)
    expect(checkAnswerStability(ctx)).toBe(false)
  })
})
