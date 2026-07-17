/**
 * Tests for ClarificationsRegistry — per-run state machine that ties an
 * ask_user call back to a previously-emitted AmbiguityFinding so the
 * user's answer can be recorded as a ResolvedClarification.
 */

import type { AmbiguityFinding } from "@mia/agent"
import { describe, expect, it } from "vitest"
import { ClarificationsRegistry } from "../src/api/runs/execution/clarifications-registry.js"

function mkFinding(over: Partial<AmbiguityFinding> = {}): AmbiguityFinding {
  return {
    id: "schema-match:revenue",
    kind: "schema-match",
    severity: "block",
    subject: "Revenue",
    reasoning: "Multiple tables match",
    suggestedQuestion: "Which Revenue table do you mean: publish.Revenue or mart.RevenueRecognition?",
    source: "detector",
    candidates: ["publish.Revenue", "mart.RevenueRecognition"],
    ...over
  }
}

describe("ClarificationsRegistry", () => {
  it("getResolved returns empty for an unseen run", () => {
    const reg = new ClarificationsRegistry()
    expect(reg.getResolved("nope")).toEqual([])
  })

  it("recordEmitted stores findings then matchQuestion finds a hit", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [mkFinding()])
    const match = reg.matchQuestion(
      "r1",
      "Which Revenue table do you mean — publish.Revenue or mart.RevenueRecognition?"
    )
    expect(match).not.toBeNull()
    expect(match?.findingId).toBe("schema-match:revenue")
    expect(match?.subject).toBe("Revenue")
  })

  it("matchQuestion preserves uiOptions for closed-choice findings", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [
      mkFinding({
        kind: "output-format",
        severity: "warn",
        subject: "overview",
        suggestedQuestion: "How would you like the overview delivered?",
        uiOptions: ["short narrative", "data table", "chart"]
      })
    ])
    const match = reg.matchQuestion("r1", "How would you like the overview delivered?")
    expect(match?.uiOptions).toEqual(["short narrative", "data table", "chart"])
  })

  it("matchQuestion returns null when the question is unrelated", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [mkFinding()])
    expect(reg.matchQuestion("r1", "What is your favourite colour?")).toBeNull()
  })

  it("matchQuestion picks the highest-overlap finding when several emitted", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [
      mkFinding(),
      mkFinding({
        id: "term-undefined:churn",
        kind: "term-undefined",
        subject: "churn",
        suggestedQuestion: "How do you define churn in this context?"
      })
    ])
    const match = reg.matchQuestion("r1", "How do you define churn — voluntary, involuntary, or both?")
    expect(match?.findingId).toBe("term-undefined:churn")
  })

  it("setPending + resolvePending produces a ResolvedClarification", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [mkFinding()])
    const question = "Which Revenue table do you mean?"
    const match = reg.matchQuestion("r1", question)!
    reg.setPending("r1", match, question)
    const resolved = reg.resolvePending("r1", "publish.Revenue", 3)
    expect(resolved).not.toBeNull()
    expect(resolved?.findingId).toBe("schema-match:revenue")
    expect(resolved?.answer).toBe("publish.Revenue")
    expect(resolved?.question).toBe(question)
    expect(resolved?.resolvedAtRound).toBe(3)
  })

  it("resolvePending without a pending entry returns null", () => {
    const reg = new ClarificationsRegistry()
    expect(reg.resolvePending("r1", "whatever", 0)).toBeNull()
  })

  it("getResolved accumulates across multiple resolutions", () => {
    const reg = new ClarificationsRegistry()
    const f1 = mkFinding()
    const f2 = mkFinding({
      id: "term-undefined:churn",
      kind: "term-undefined",
      subject: "churn",
      suggestedQuestion: "How do you define churn?"
    })
    reg.recordEmitted("r1", 0, [f1, f2])
    reg.setPending(
      "r1",
      {
        findingId: f1.id,
        kind: f1.kind,
        subject: f1.subject,
        suggestedQuestion: f1.suggestedQuestion,
        round: 0
      },
      "Which revenue?"
    )
    reg.resolvePending("r1", "publish.Revenue", 1)
    reg.setPending(
      "r1",
      {
        findingId: f2.id,
        kind: f2.kind,
        subject: f2.subject,
        suggestedQuestion: f2.suggestedQuestion,
        round: 0
      },
      "Define churn?"
    )
    reg.resolvePending("r1", "voluntary", 2)
    const resolved = reg.getResolved("r1")
    expect(resolved).toHaveLength(2)
    expect(resolved[0].answer).toBe("publish.Revenue")
    expect(resolved[1].answer).toBe("voluntary")
  })

  it("runs are isolated", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [mkFinding()])
    expect(reg.matchQuestion("r2", "Which Revenue table?")).toBeNull()
  })

  it("clear removes all per-run state", () => {
    const reg = new ClarificationsRegistry()
    reg.recordEmitted("r1", 0, [mkFinding()])
    reg.setPending(
      "r1",
      { findingId: "x", kind: "schema-match", subject: "Revenue", suggestedQuestion: "q", round: 0 },
      "q"
    )
    reg.resolvePending("r1", "answer", 0)
    reg.clear("r1")
    expect(reg.getResolved("r1")).toEqual([])
    expect(reg.matchQuestion("r1", "Which Revenue table?")).toBeNull()
  })

  it("setPending replaces a previous pending entry", () => {
    const reg = new ClarificationsRegistry()
    const f1 = mkFinding()
    const f2 = mkFinding({
      id: "term-undefined:churn",
      kind: "term-undefined",
      subject: "churn",
      suggestedQuestion: "How do you define churn?"
    })
    reg.recordEmitted("r1", 0, [f1, f2])
    reg.setPending(
      "r1",
      {
        findingId: f1.id,
        kind: f1.kind,
        subject: f1.subject,
        suggestedQuestion: f1.suggestedQuestion,
        round: 0
      },
      "Q1"
    )
    reg.setPending(
      "r1",
      {
        findingId: f2.id,
        kind: f2.kind,
        subject: f2.subject,
        suggestedQuestion: f2.suggestedQuestion,
        round: 0
      },
      "Q2"
    )
    const resolved = reg.resolvePending("r1", "voluntary", 1)
    expect(resolved?.findingId).toBe(f2.id)
  })
})
