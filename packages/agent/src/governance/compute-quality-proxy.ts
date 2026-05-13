/**
 * Quality proxy computation — numeric estimate of execution quality.
 *
 * Ported from agenc-core's computeQualityProxy. Maps execution outcome
 * signals (completion state, verifier result, failure count) to a 0–1 score.
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

export interface QualityProxyInput {
  readonly completionState: "completed" | "needs_verification" | "partial" | "blocked"
  readonly verifierPerformed: boolean
  readonly verifierOverall: "pass" | "retry" | "fail" | "skipped"
  readonly failedToolCalls: number
}

// ============================================================================
// Computation
// ============================================================================

/** Compute a 0–1 quality proxy score from execution outcome signals. */
export function computeQualityProxy(input: QualityProxyInput): number {
  const base = input.completionState === "completed" ? 0.85
    : input.completionState === "needs_verification" ? 0.6
    : input.completionState === "partial" ? 0.45
    : 0.25
  const verifierBonus = input.verifierPerformed
    ? (input.verifierOverall === "pass" ? 0.1 : input.verifierOverall === "retry" ? 0 : -0.15)
    : 0
  const failurePenalty = Math.min(0.25, input.failedToolCalls * 0.05)
  return Math.max(0, Math.min(1, base + verifierBonus - failurePenalty))
}
