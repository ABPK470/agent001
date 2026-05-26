/**
 * F1.4 — `rankProposals` deterministic ordering.
 *
 * Covers:
 *  - critical > high > medium > low ordering with same score
 *  - blocking warnings add the +25 bonus
 *  - topological hoist: dependency entityType appears before dependents
 *  - cycle detection sets the flag without crashing
 *  - missing annotation → critical placeholder so it bubbles up
 *  - lineageCentrality contributes deterministically
 */

import type { RiskAnnotation } from "@mia/sync"
import {
    ProposalKind,
    rankProposals,
    RiskTier,
    type ProposerFinding,
    type RankableProposal,
} from "@mia/sync"
import { describe, expect, it } from "vitest"

function finding(entityType: string, observedAt = "2025-01-15T12:00:00.000Z"): ProposerFinding {
  return {
    envPair:           { source: "uat", target: "prod" },
    entityType,
    entityId:          `${entityType}-1`,
    entityLabel:       entityType,
    kind:              ProposalKind.OutOfSync,
    counts:            { insert: 1, update: 0, delete: 0, unchanged: 0, unknown: 0 },
    detail:            { kind: "out_of_sync", outOfSync: { perTable: [] } },
    fingerprint:       `fp-${entityType}`,
    entityDefVersion:  1,
    observedAt,
  }
}

function annotation(over: Partial<RiskAnnotation> = {}): RiskAnnotation {
  return {
    riskTier:          RiskTier.Medium,
    riskScore:         40,
    rationale:         "Sentence one. Sentence two. Sentence three.",
    recommendedWindow: "any",
    dependsOn:         [],
    warnings:          [],
    ...over,
  }
}

function prop(id: string, entityType: string, ann: RiskAnnotation | null): RankableProposal {
  return { id, finding: finding(entityType), annotation: ann, enqueuedAt: "2025-01-15T12:00:00.000Z" }
}

describe("rankProposals", () => {
  it("orders critical > high > medium > low", () => {
    const r = rankProposals([
      prop("p-low",      "a", annotation({ riskTier: RiskTier.Low,      riskScore: 5  })),
      prop("p-critical", "b", annotation({ riskTier: RiskTier.Critical, riskScore: 95 })),
      prop("p-medium",   "c", annotation({ riskTier: RiskTier.Medium,   riskScore: 45 })),
      prop("p-high",     "d", annotation({ riskTier: RiskTier.High,     riskScore: 70 })),
    ])
    expect(r.ranked.map((x) => x.id)).toEqual(["p-critical", "p-high", "p-medium", "p-low"])
  })

  it("adds +25 for blocking warning kinds", () => {
    const r = rankProposals([
      prop("plain", "a", annotation({ riskTier: RiskTier.Medium, riskScore: 30 })),
      prop("blocked", "b", annotation({
        riskTier: RiskTier.Medium, riskScore: 30,
        warnings: [{ kind: "freeze-window-violation", message: "x" }],
      })),
    ])
    expect(r.ranked[0]!.id).toBe("blocked")
    expect(r.ranked[0]!.score - r.ranked[1]!.score).toBeCloseTo(25, 5)
  })

  it("hoists dependencies ahead of dependents", () => {
    const r = rankProposals([
      prop("p-dependent", "consumer", annotation({ riskTier: RiskTier.Critical, riskScore: 90, dependsOn: ["producer"] })),
      prop("p-producer",  "producer", annotation({ riskTier: RiskTier.Low,      riskScore: 5 })),
    ])
    const order = r.ranked.map((x) => x.finding.entityType)
    expect(order.indexOf("producer")).toBeLessThan(order.indexOf("consumer"))
    expect(r.cycleDetected).toBe(false)
  })

  it("sets cycleDetected when dependencies form a loop", () => {
    const r = rankProposals([
      prop("p-a", "a", annotation({ dependsOn: ["b"] })),
      prop("p-b", "b", annotation({ dependsOn: ["a"] })),
    ])
    expect(r.cycleDetected).toBe(true)
    expect(r.ranked.map((x) => x.id).sort()).toEqual(["p-a", "p-b"])
  })

  it("treats missing annotation as critical placeholder (bubbles up)", () => {
    const r = rankProposals([
      prop("ann", "a", annotation({ riskTier: RiskTier.Medium, riskScore: 30 })),
      prop("raw", "b", null),
    ])
    expect(r.ranked[0]!.id).toBe("raw")
  })

  it("incorporates lineageCentrality monotonically", () => {
    const items = [prop("p", "lineage-heavy", annotation({ riskTier: RiskTier.Medium, riskScore: 30 }))]
    const low  = rankProposals(items, () => new Date("2025-01-15T12:00:00.000Z"), { lineageCentrality: () => 0   })
    const high = rankProposals(items, () => new Date("2025-01-15T12:00:00.000Z"), { lineageCentrality: () => 1   })
    expect(high.ranked[0]!.score - low.ranked[0]!.score).toBeCloseTo(30, 5)
  })
})
