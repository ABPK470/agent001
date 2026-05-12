/**
 * Escalation graph — deterministic state machine for verification outcomes.
 *
 * Ported from agenc-core's escalation-graph.ts.
 * A pure function that maps (verdict, attempts, constraints) to a next action.
 * No side effects, no randomness, fully testable.
 *
 * States: pass | retry | revise | escalate
 *
 * The escalation graph replaces ad-hoc retry logic with a structured
 * decision function that considers:
 *   - Current verdict (pass/retry/fail)
 *   - Attempts remaining
 *   - Budget constraints
 *   - Disagreement between verifier rounds
 *   - Whether revision (targeted fix) is available vs full re-execution
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

/** Possible outcomes from the escalation graph. */
export type EscalationAction = "pass" | "retry" | "revise" | "escalate"

/** Reason codes for escalation decisions. */
export type EscalationReason =
  | "pass"
  | "retry_allowed"
  | "needs_revision"
  | "retries_exhausted"
  | "revision_unavailable"
  | "disagreement_threshold"
  | "timeout"
  | "budget_exhausted"
  | "all_steps_stuck"

/** Input to the escalation graph. */
export interface EscalationInput {
  /** Current verification verdict. */
  readonly verdict: "pass" | "retry" | "fail"
  /** Current attempt number (0-based). */
  readonly attempt: number
  /** Maximum allowed attempts. */
  readonly maxAttempts: number
  /** Number of pairwise disagreements between verifier assessments. */
  readonly disagreements: number
  /** Maximum allowed disagreements before escalation. */
  readonly maxDisagreements: number
  /** Whether a targeted revision path is available (vs full re-execution). */
  readonly revisionAvailable: boolean
  /** Whether to re-execute entirely on "needs_revision" (vs targeted revise). */
  readonly reexecuteOnNeedsRevision: boolean
  /** Whether the pipeline timed out. */
  readonly timedOut?: boolean
  /** Whether budget is exhausted. */
  readonly budgetExhausted?: boolean
  /** Whether all failing steps have repeated identical issues (stuck). */
  readonly allStepsStuck?: boolean
}

/** Output of the escalation graph. */
export interface EscalationDecision {
  readonly action: EscalationAction
  readonly reason: EscalationReason
}

// ============================================================================
// The escalation graph — pure deterministic function
// ============================================================================

/**
 * Resolve the next action given the current verification state.
 *
 * Resolution order (first match wins):
 *   1. timedOut → escalate
 *   2. budgetExhausted → escalate
 *   3. allStepsStuck → escalate
 *   4. verdict === "pass" → pass
 *   5. disagreements >= maxDisagreements → escalate
 *   6. No attempts remaining → escalate (retries_exhausted)
 *   7. verdict === "fail" + revision available → revise
 *   8. verdict === "fail" + no revision path → escalate
 *   9. verdict === "retry" + revision available → revise
 *  10. verdict === "retry" + reexecute mode → retry
 *  11. verdict === "retry" + neither → escalate (revision_unavailable)
 */
export function resolveEscalation(input: EscalationInput): EscalationDecision {
  // Hard stops — these override everything
  if (input.timedOut) {
    return { action: "escalate", reason: "timeout" }
  }
  if (input.budgetExhausted) {
    return { action: "escalate", reason: "budget_exhausted" }
  }
  if (input.allStepsStuck) {
    return { action: "escalate", reason: "all_steps_stuck" }
  }

  // Success
  if (input.verdict === "pass") {
    return { action: "pass", reason: "pass" }
  }

  // Disagreement threshold — too many conflicting verifier assessments
  if (input.disagreements >= input.maxDisagreements) {
    return { action: "escalate", reason: "disagreement_threshold" }
  }

  // No attempts left
  if (input.attempt >= input.maxAttempts - 1) {
    return { action: "escalate", reason: "retries_exhausted" }
  }

  // Fail verdict — if a repair path exists, keep revising until attempts are exhausted
  // or the caller marks the run as stuck. Syntax errors and similar structural defects
  // are often fixable in a second or third pass and should not escalate after one try.
  if (input.verdict === "fail") {
    if (input.revisionAvailable) {
      return { action: "revise", reason: "needs_revision" }
    }
    return { action: "escalate", reason: "retries_exhausted" }
  }

  // Retry verdict — choose between revise (targeted) and retry (full re-execute)
  if (input.verdict === "retry") {
    if (input.revisionAvailable) {
      return { action: "revise", reason: "needs_revision" }
    }
    if (input.reexecuteOnNeedsRevision) {
      return { action: "retry", reason: "retry_allowed" }
    }
    return { action: "escalate", reason: "revision_unavailable" }
  }

  // Default fallback
  return { action: "retry", reason: "retry_allowed" }
}

// ============================================================================
// Helper: build escalation input from planner state
// ============================================================================

/**
 * Build an EscalationInput from the current planner retry state.
 * This bridges the gap between the planner's retry logic and the
 * escalation graph.
 */
export function buildEscalationInput(params: {
  verifierOverall: "pass" | "retry" | "fail"
  attempt: number
  maxAttempts: number
  hasRetryableSteps: boolean
  allStepsRepeatedFailure: boolean
  timedOut?: boolean
  budgetExhausted?: boolean
}): EscalationInput {
  return {
    verdict: params.verifierOverall,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    disagreements: 0, // agent001 doesn't yet track multi-candidate disagreement
    maxDisagreements: 3, // default threshold
    revisionAvailable: params.hasRetryableSteps,
    reexecuteOnNeedsRevision: true, // agent001 always re-executes (no targeted revision yet)
    timedOut: params.timedOut,
    budgetExhausted: params.budgetExhausted,
    allStepsStuck: params.allStepsRepeatedFailure,
  }
}
