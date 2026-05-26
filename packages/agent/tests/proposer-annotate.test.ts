/**
 * F1.3 — `annotateProposal` validates / retries / fails-open.
 *
 * Covers:
 *  - happy path: schema-valid first reply returns the annotation
 *  - schema-invalid first reply triggers retry with issue list
 *  - all attempts invalid → synthetic critical annotation (failedOpen)
 *  - cache hit short-circuits LLM
 *  - markdown code-fence stripping
 */

import { describe, expect, it, vi } from "vitest"
import {
    annotateProposal,
    ProposalKind,
    RiskTier,
    type AnnotatorCache,
    type LlmCompletionPort,
    type ProposerFinding,
    type RiskAnnotation,
} from "../../sync/src/proposer/index.js"

function finding(): ProposerFinding {
  return {
    envPair:          { source: "uat", target: "prod" },
    entityType:       "contract",
    entityId:         "c1",
    entityLabel:      "Contract c1",
    kind:             ProposalKind.OutOfSync,
    counts:           { insert: 0, update: 5, delete: 0, unchanged: 100, unknown: 0 },
    detail:           { kind: "out_of_sync", outOfSync: { perTable: [] } },
    fingerprint:      "abc",
    entityDefVersion: 1,
    observedAt:       "2025-01-15T12:00:00.000Z",
  }
}

function validReply(over: Partial<RiskAnnotation> = {}): string {
  const ann: RiskAnnotation = {
    riskTier:          RiskTier.Medium,
    riskScore:         40,
    rationale:         "Plain rationale sentence one. Sentence two. Sentence three.",
    recommendedWindow: "any",
    dependsOn:         [],
    warnings:          [],
    ...over,
  }
  return JSON.stringify(ann)
}

function port(replies: string[]): LlmCompletionPort {
  const queue = [...replies]
  return {
    complete: vi.fn(async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error("LLM mock exhausted")
      return next
    }),
  }
}

describe("annotateProposal", () => {
  it("returns the annotation on a valid first reply", async () => {
    const r = await annotateProposal(finding(), {}, port([validReply()]))
    expect(r.failedOpen).toBe(false)
    expect(r.attempts).toBe(1)
    expect(r.annotation.riskTier).toBe(RiskTier.Medium)
  })

  it("retries on schema-invalid reply", async () => {
    const r = await annotateProposal(finding(), {}, port(["not-json", validReply()]))
    expect(r.attempts).toBe(2)
    expect(r.failedOpen).toBe(false)
  })

  it("fails open with synthetic critical annotation after maxAttempts", async () => {
    const r = await annotateProposal(finding(), {}, port(["nope", "{}", "still bad"]))
    expect(r.failedOpen).toBe(true)
    expect(r.annotation.riskTier).toBe(RiskTier.Critical)
    expect(r.annotation.warnings).toHaveLength(1)
  })

  it("short-circuits on cache hit", async () => {
    const stored: RiskAnnotation = {
      riskTier: RiskTier.Low, riskScore: 5,
      rationale: "Cached.", recommendedWindow: "any", dependsOn: [], warnings: [],
    }
    const cache: AnnotatorCache = { get: () => stored, put: vi.fn() }
    const p = port([]) // would throw if invoked
    const r = await annotateProposal(finding(), {}, p, cache)
    expect(r.failedOpen).toBe(false)
    expect(r.annotation).toBe(stored)
    expect(p.complete).not.toHaveBeenCalled()
  })

  it("strips markdown code-fence around the JSON payload", async () => {
    const fenced = "```json\n" + validReply() + "\n```"
    const r = await annotateProposal(finding(), {}, port([fenced]))
    expect(r.failedOpen).toBe(false)
    expect(r.annotation.riskTier).toBe(RiskTier.Medium)
  })
})
