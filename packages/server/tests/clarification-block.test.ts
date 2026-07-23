/**
 * Tests for buildClarificationBlock — renders the <must_clarify> /
 * <resolved_clarifications> system block.
 */

import type { AmbiguityFinding, ResolvedClarification } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { buildClarificationBlock } from "../src/runtime/prompting/clarification-block.js"

function mkFinding(over: Partial<AmbiguityFinding> = {}): AmbiguityFinding {
  return {
    id: "schema-match:revenue",
    kind: "schema-match",
    severity: "block",
    subject: "Revenue",
    reasoning: "2 tables match the name",
    suggestedQuestion: "Which Revenue table do you mean?",
    source: "detector",
    candidates: ["publish.Revenue", "mart.RevenueRecognition"],
    ...over
  }
}

describe("buildClarificationBlock", () => {
  it("returns empty when no findings and no resolved", () => {
    expect(buildClarificationBlock({ findings: [], resolved: [] })).toBe("")
  })

  it("renders <must_clarify> with blocking findings first", () => {
    const block = buildClarificationBlock({
      findings: [
        mkFinding({
          id: "time-range:last-quarter",
          kind: "time-range",
          severity: "warn",
          subject: "last quarter",
          suggestedQuestion: "Which quarter?",
          source: "detector",
          candidates: undefined
        }),
        mkFinding()
      ],
      resolved: []
    })
    expect(block).toContain("<must_clarify>")
    expect(block).toContain("</must_clarify>")
    // Block finding (🛑) must precede warn (⚠) in the output.
    const blockIdx = block.indexOf("🛑")
    const warnIdx = block.indexOf("⚠")
    expect(blockIdx).toBeGreaterThan(-1)
    expect(warnIdx).toBeGreaterThan(blockIdx)
  })

  it("renders candidates list when present", () => {
    const block = buildClarificationBlock({ findings: [mkFinding()], resolved: [] })
    expect(block).toContain("candidates: publish.Revenue, mart.RevenueRecognition")
  })

  it("tells the agent not to copy candidates into ask_user options", () => {
    const block = buildClarificationBlock({ findings: [mkFinding()], resolved: [] })
    expect(block).toContain("`candidates` are reasoning context only")
    expect(block).toContain("do NOT copy them into ask_user options")
  })

  it("renders ui options only when a finding explicitly provides them", () => {
    const block = buildClarificationBlock({
      findings: [
        mkFinding({
          kind: "output-format",
          severity: "warn",
          subject: "overview",
          uiOptions: ["short narrative", "data table", "chart"]
        })
      ],
      resolved: []
    })
    expect(block).toContain("ui options: short narrative, data table, chart")
  })

  it("omits candidates line when not provided", () => {
    const block = buildClarificationBlock({
      findings: [mkFinding({ candidates: undefined })],
      resolved: []
    })
    expect(block).not.toContain("candidates:")
  })

  it("renders <resolved_clarifications> with answers", () => {
    const resolved: ResolvedClarification[] = [
      {
        findingId: "schema-match:revenue",
        kind: "schema-match",
        subject: "Revenue",
        question: "Which Revenue table?",
        answer: "publish.Revenue",
        resolvedAtRound: 1
      }
    ]
    const block = buildClarificationBlock({ findings: [], resolved })
    expect(block).toContain("<resolved_clarifications>")
    expect(block).toContain('subject="Revenue"')
    expect(block).toContain("answer: publish.Revenue")
  })

  it("renders both sections when both supplied", () => {
    const block = buildClarificationBlock({
      findings: [mkFinding({ id: "term-undefined:churn", kind: "term-undefined", subject: "churn" })],
      resolved: [
        {
          findingId: "schema-match:revenue",
          kind: "schema-match",
          subject: "Revenue",
          question: "q",
          answer: "a",
          resolvedAtRound: 0
        }
      ]
    })
    expect(block).toContain("<must_clarify>")
    expect(block).toContain("<resolved_clarifications>")
  })

  it("tags finding source in the bullet", () => {
    const block = buildClarificationBlock({
      findings: [mkFinding({ source: "llm-planner" })],
      resolved: []
    })
    expect(block).toContain("source: llm-planner")
  })

  it("truncates by dropping warns when over budget", () => {
    const warns = Array.from({ length: 50 }, (_, i) =>
      mkFinding({
        id: `warn:${i}`,
        kind: "time-range",
        severity: "warn",
        subject: `t${i}`,
        reasoning: "x".repeat(200)
      })
    )
    const blocked = mkFinding()
    const block = buildClarificationBlock({ findings: [blocked, ...warns], resolved: [] })
    expect(block).toContain("🛑")
    expect(block).toContain('subject="Revenue"')
    expect(block.length).toBeLessThanOrEqual(2048 + 64)
  })
})
