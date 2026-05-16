/**
 * F1.4 — Ranker.
 *
 * Combines deterministic findings with their (optional) LLM annotations
 * into an ordered, grouped queue suitable for human reviewer attention.
 *
 * Ranking weights (rubric — keep in sync with docs/sync/fork1/runbook.md):
 *   • tier  : critical(80) > high(60) > medium(35) > low(10)
 *   • score : annotation.riskScore on [0,100]   ×0.40
 *   • age   : minutes since observedAt × 0.05 (capped at 30 = +1.5/min)
 *   • lineage centrality : weighted in via deps (0..1)  ×30
 *   • bonus : +25 if any blocking warning kind present
 *
 * Topological grouping: when annotation.dependsOn[i] points at another
 * entity in the queue, the dependency is hoisted ahead of its dependents.
 * Cycles fall back to alphabetical order on entityType to keep ranking
 * stable (and a `cycleDetected` flag is set on the result).
 */

import type { RiskAnnotation } from "./annotation-schema.js"
import type { ProposerFinding, RiskTier } from "./types.js"

export interface RankableProposal {
  /** Persistent proposal id (from F1.2 storage). */
  id:          string
  finding:     ProposerFinding
  annotation:  RiskAnnotation | null
  /** ISO time the proposal entered the queue. */
  enqueuedAt:  string
}

export interface RankerDeps {
  /** 0..1 normalised "how many downstream consumers depend on this entity". */
  lineageCentrality?: (entityType: string) => number
}

export interface RankedProposal extends RankableProposal {
  score:   number
  rank:    number
  /** entityType bucket — UI groups by this so reviewers can ack a batch. */
  groupId: string
}

export interface RankResult {
  ranked:          readonly RankedProposal[]
  cycleDetected:   boolean
}

const TIER_BASELINE: Readonly<Record<RiskTier, number>> = {
  critical: 80,
  high:     60,
  medium:   35,
  low:      10,
} as const

const BLOCKING_WARNINGS: ReadonlySet<string> = new Set([
  "regulatory-downstream",
  "freeze-window-violation",
  "large-delete-batch",
])

export function rankProposals(
  proposals: readonly RankableProposal[],
  now: () => Date = () => new Date(),
  deps: RankerDeps = {},
): RankResult {
  const scored = proposals.map((p) => ({ p, score: scoreOne(p, now(), deps) }))

  // Order by score DESC, tiebreak by entityType ASC, then by id ASC
  scored.sort((a, b) =>
    b.score - a.score ||
    a.p.finding.entityType.localeCompare(b.p.finding.entityType) ||
    a.p.id.localeCompare(b.p.id),
  )

  // Topological hoist: for each proposal whose annotation.dependsOn refs
  // an entityType currently in the queue, ensure those run first.
  const hoisted = topoHoist(scored.map((s) => ({ ...s.p, score: s.score })))

  const ranked: RankedProposal[] = hoisted.list.map((item, idx) => ({
    ...item,
    rank:    idx + 1,
    groupId: item.finding.entityType,
  }))

  return { ranked, cycleDetected: hoisted.cycleDetected }
}

// ── scoring ─────────────────────────────────────────────────────

function scoreOne(p: RankableProposal, now: Date, deps: RankerDeps): number {
  let s = 0
  if (p.annotation) {
    s += TIER_BASELINE[p.annotation.riskTier]
    s += p.annotation.riskScore * 0.40
    if (p.annotation.warnings.some((w) => BLOCKING_WARNINGS.has(w.kind))) s += 25
  } else {
    // No annotation yet (annotator failed open or pending) → treat as
    // critical placeholder so it bubbles up; cleared once annotated.
    s += TIER_BASELINE.critical
  }
  const ageMin = Math.max(0, (now.getTime() - Date.parse(p.finding.observedAt)) / 60_000)
  s += Math.min(30, ageMin * 0.05)
  if (deps.lineageCentrality) {
    const lc = clamp01(deps.lineageCentrality(p.finding.entityType))
    s += lc * 30
  }
  return s
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

// ── topological hoist (stable, with cycle fallback) ─────────────

interface ScoredItem extends RankableProposal {
  score: number
}

function topoHoist(items: readonly ScoredItem[]): { list: ScoredItem[]; cycleDetected: boolean } {
  // Index by entityType — multiple proposals may share a type, so the
  // map values are arrays preserving original (score-ordered) order.
  const byType = new Map<string, ScoredItem[]>()
  for (const it of items) {
    const k = it.finding.entityType
    const arr = byType.get(k) ?? []
    arr.push(it)
    byType.set(k, arr)
  }

  const visited = new Set<string>()
  const onStack = new Set<string>()
  const out: ScoredItem[] = []
  let cycleDetected = false

  const visit = (type: string): void => {
    if (visited.has(type)) return
    if (onStack.has(type)) { cycleDetected = true; return }
    onStack.add(type)
    const bucket = byType.get(type) ?? []
    for (const it of bucket) {
      for (const dep of it.annotation?.dependsOn ?? []) {
        if (dep !== type && byType.has(dep)) visit(dep)
      }
    }
    onStack.delete(type)
    visited.add(type)
    out.push(...bucket)
  }

  // Walk in original (score-DESC) entity-type order so cycle-fallback is stable.
  const order: string[] = []
  for (const it of items) {
    if (!order.includes(it.finding.entityType)) order.push(it.finding.entityType)
  }
  for (const t of order) visit(t)
  return { list: out, cycleDetected }
}
