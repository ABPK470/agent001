import { applyMutations, loadTrajectory } from "./loader.js"
import { generateScorecard, type Scorecard } from "./scorer.js"
import type { Mutation, Trajectory } from "./types.js"

// ── State machine ────────────────────────────────────────────────

/**
 * Valid transitions in the agent state machine:
 *
 *   goal → thinking | tool-call | answer | error | iteration
 *   thinking → tool-call | answer | error | delegation-start | iteration | thinking
 *   tool-call → tool-result | tool-error | delegation-start (delegate tool starts child)
 *   tool-result → thinking | tool-call | answer | iteration | error | delegation-start
 *   tool-error → thinking | tool-call | answer | error | iteration
 *   iteration → thinking | tool-call | answer | error
 *   delegation-start → delegation-end | delegation-start (parallel children) | tool-call | thinking | delegation-iteration | iteration
 *   delegation-iteration → delegation-start | delegation-end | tool-call | thinking | delegation-iteration | iteration
 *   delegation-end → thinking | tool-call | answer | iteration | delegation-start | delegation-end | tool-result
 *   answer → (terminal)
 *   error → (terminal)
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  "goal":                 new Set(["thinking", "tool-call", "answer", "error", "iteration"]),
  "thinking":             new Set(["tool-call", "answer", "error", "delegation-start", "iteration", "thinking"]),
  "tool-call":            new Set(["tool-result", "tool-error", "delegation-start"]),
  "tool-result":          new Set(["thinking", "tool-call", "answer", "iteration", "error", "delegation-start"]),
  "tool-error":           new Set(["thinking", "tool-call", "answer", "error", "iteration"]),
  "iteration":            new Set(["thinking", "tool-call", "answer", "error"]),
  "delegation-start":     new Set(["delegation-end", "delegation-start", "tool-call", "thinking", "delegation-iteration", "iteration"]),
  "delegation-iteration": new Set(["delegation-start", "delegation-end", "tool-call", "thinking", "delegation-iteration", "iteration"]),
  "delegation-end":       new Set(["thinking", "tool-call", "answer", "iteration", "delegation-start", "delegation-end", "tool-result"]),
}

// ── Transition validation ────────────────────────────────────────

export interface TransitionViolation {
  seq: number
  from: string
  to: string
  message: string
}

/** Validate all state transitions in a trajectory. */
export function validateTransitions(trajectory: Trajectory): TransitionViolation[] {
  const violations: TransitionViolation[] = []
  let delegationDepth = 0

  // "usage", "delegation-iteration", and "delegation-parallel-*" are
  // observability/meta events, not agent states. They can appear between any
  // pair of real states and should be transparent to the state machine validator.
  const META_KINDS = new Set([
    "usage", "delegation-iteration", "delegation-parallel-start", "delegation-parallel-end",
    "system-prompt", "tools-resolved", "llm-request", "llm-response",
    "user-input-request", "user-input-response", "planner-validation-remediated",
  ])

  const stateEvents: Array<{ seq: number; kind: string }> = []
  for (const entry of trajectory.events) {
    if (!META_KINDS.has(entry.event.kind)) {
      stateEvents.push({ seq: entry.seq, kind: entry.event.kind })
    }
  }

  for (let i = 1; i < stateEvents.length; i++) {
    const prev = stateEvents[i - 1].kind
    const curr = stateEvents[i].kind

    if (prev === "delegation-start") delegationDepth++
    if (curr === "delegation-end") delegationDepth = Math.max(0, delegationDepth - 1)

    // Inside a delegation block child events follow their own state machine
    if (delegationDepth > 0) continue

    if (prev === "answer" || prev === "error") {
      violations.push({ seq: stateEvents[i].seq, from: prev, to: curr, message: `Event after terminal state "${prev}"` })
      continue
    }

    const valid = VALID_TRANSITIONS[prev]
    if (valid && !valid.has(curr)) {
      violations.push({ seq: stateEvents[i].seq, from: prev, to: curr, message: `Invalid transition: "${prev}" → "${curr}"` })
    }
  }

  return violations
}

// ── Replay ───────────────────────────────────────────────────────

export interface ReplayResult {
  /** Did the replay complete without violations? */
  valid: boolean
  /** State transition violations found. */
  violations: TransitionViolation[]
  /** Generated scorecard. */
  scorecard: Scorecard
  /** The (possibly mutated) trajectory that was replayed. */
  trajectory: Trajectory
}

/**
 * Replay a trajectory with optional mutations and generate a scorecard.
 * This is a "dry replay" — no LLM calls, no tool execution.
 */
export function replay(runId: string, mutations?: Mutation[]): ReplayResult {
  let trajectory = loadTrajectory(runId)
  if (mutations && mutations.length > 0) {
    trajectory = applyMutations(trajectory, mutations)
  }

  const violations = validateTransitions(trajectory)
  const scorecard = generateScorecard(trajectory)

  return { valid: violations.length === 0, violations, scorecard, trajectory }
}
