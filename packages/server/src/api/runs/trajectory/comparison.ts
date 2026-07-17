import { TrajectoryEventKind } from "../../../shared/enums/trajectory.js"
import type { GoalEvent } from "./types.js"
import { replay } from "./validator.js"

// ── Comparison ───────────────────────────────────────────────────

export interface TrajectoryComparison {
  /** Both runs attempted the same goal? */
  sameGoal: boolean
  /** Goal similarity score (0–1). 1 = identical after normalization. */
  goalSimilarity: number
  /** Overlap in tools used (Jaccard similarity 0–1). */
  toolOverlap: number
  /** Difference in tool call count. */
  toolCallDelta: number
  /** Difference in iteration count. */
  iterationDelta: number
  /** Difference in error rate. */
  errorRateDelta: number
  /** Which run was more efficient (fewer events per iteration)? */
  moreEfficient: "a" | "b" | "equal"
  /** Outcome for run A. */
  outcomeA: "answer" | "error" | "incomplete"
  /** Outcome for run B. */
  outcomeB: "answer" | "error" | "incomplete"
  /** Summary. */
  summary: string
}

/** Dice coefficient for bigram similarity (0–1). */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = (s: string) => {
    const set = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2)
      set.set(bi, (set.get(bi) ?? 0) + 1)
    }
    return set
  }
  const bA = bigrams(a)
  const bB = bigrams(b)
  let overlap = 0
  for (const [bi, count] of bA) {
    overlap += Math.min(count, bB.get(bi) ?? 0)
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

/**
 * Compare two trajectories — useful for before/after analysis
 * or comparing different agent configurations on the same goal.
 */
export function compareTrajectories(runIdA: string, runIdB: string): TrajectoryComparison {
  const a = replay(runIdA)
  const b = replay(runIdB)

  const goalA = a.trajectory.events.find((e) => e.event.kind === TrajectoryEventKind.Goal)
  const goalB = b.trajectory.events.find((e) => e.event.kind === TrajectoryEventKind.Goal)
  const goalTextA = goalA ? (goalA.event as GoalEvent).text : ""
  const goalTextB = goalB ? (goalB.event as GoalEvent).text : ""
  const normA = goalTextA.trim().toLowerCase().replace(/\s+/g, " ")
  const normB = goalTextB.trim().toLowerCase().replace(/\s+/g, " ")
  const sameGoal = !!(normA && normB && normA === normB)
  const goalSimilarity = normA && normB ? (normA === normB ? 1 : diceCoefficient(normA, normB)) : 0

  const toolsA = new Set(a.scorecard.toolsUsed)
  const toolsB = new Set(b.scorecard.toolsUsed)
  const intersection = new Set([...toolsA].filter((t) => toolsB.has(t)))
  const union = new Set([...toolsA, ...toolsB])
  const toolOverlap = union.size > 0 ? intersection.size / union.size : 1

  const moreEfficient =
    a.scorecard.eventsPerIteration < b.scorecard.eventsPerIteration
      ? "a"
      : a.scorecard.eventsPerIteration > b.scorecard.eventsPerIteration
        ? "b"
        : "equal"

  const outcomeA: "answer" | "error" | "incomplete" = a.scorecard.hasAnswer
    ? "answer"
    : a.scorecard.hasError
      ? "error"
      : "incomplete"
  const outcomeB: "answer" | "error" | "incomplete" = b.scorecard.hasAnswer
    ? "answer"
    : b.scorecard.hasError
      ? "error"
      : "incomplete"

  const lines: string[] = []
  if (sameGoal) {
    lines.push("Same goal.")
  } else if (goalSimilarity > 0.6) {
    lines.push(`Similar goals (${Math.round(goalSimilarity * 100)}% match).`)
  } else {
    lines.push("Different goals — comparison may not be meaningful.")
  }
  lines.push(`Tool overlap: ${Math.round(toolOverlap * 100)}%`)
  lines.push(`Run A: ${a.scorecard.toolCalls} calls, ${a.scorecard.iterations} iters → ${outcomeA}`)
  lines.push(`Run B: ${b.scorecard.toolCalls} calls, ${b.scorecard.iterations} iters → ${outcomeB}`)
  if (a.scorecard.patterns.length || b.scorecard.patterns.length) {
    const pA = a.scorecard.patterns.join(", ") || "none"
    const pB = b.scorecard.patterns.join(", ") || "none"
    lines.push(`Patterns — A: ${pA}; B: ${pB}`)
  }

  return {
    sameGoal,
    goalSimilarity,
    toolOverlap,
    toolCallDelta: a.scorecard.toolCalls - b.scorecard.toolCalls,
    iterationDelta: a.scorecard.iterations - b.scorecard.iterations,
    errorRateDelta: a.scorecard.errorRate - b.scorecard.errorRate,
    moreEfficient,
    outcomeA,
    outcomeB,
    summary: lines.join(" ")
  }
}
