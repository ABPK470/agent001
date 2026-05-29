/**
 * Circuit breaker — prevent infinite retry loops on tool failures.
 *
 * Tracks tool call failures by semantic key (tool name + args hash).
 * When failures for a key exceed the threshold, the circuit opens and
 * that tool+args combination is blocked.
 *
 * Also implements budget extension: when the pipeline IS making progress
 * (completing steps), the parent agent gets extra iterations.
 *
 * @module
 */

import type { CircuitBreakerState } from "./types.js"

// ============================================================================
// Circuit breaker
// ============================================================================

const DEFAULT_FAILURE_THRESHOLD = 3

/**
 * Create a fresh circuit breaker state.
 */
export function createCircuitBreaker(): CircuitBreakerState {
  return {
    failures: new Map(),
    open: false,
    reason: undefined,
  }
}

/**
 * Build a semantic key for a tool call (tool name + simplified args hash).
 */
export function buildSemanticKey(toolName: string, args: Record<string, unknown>): string {
  // Sort keys for deterministic hashing
  const sortedArgs = JSON.stringify(args, Object.keys(args).sort())
  // Simple hash — we just need uniqueness, not cryptographic security
  let hash = 0
  for (let i = 0; i < sortedArgs.length; i++) {
    const char = sortedArgs.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit int
  }
  return `${toolName}:${hash.toString(36)}`
}

/**
 * Record a tool call failure. Returns updated state.
 * If failures exceed threshold, opens the circuit.
 */
export function recordFailure(
  state: CircuitBreakerState,
  toolName: string,
  args: Record<string, unknown>,
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): CircuitBreakerState {
  const key = buildSemanticKey(toolName, args)
  const newFailures = new Map(state.failures)
  const count = (newFailures.get(key) ?? 0) + 1
  newFailures.set(key, count)

  const shouldOpen = count >= threshold

  return {
    failures: newFailures,
    open: state.open || shouldOpen,
    reason: shouldOpen
      ? `Tool "${toolName}" failed ${count} times with same arguments`
      : state.reason,
  }
}

/**
 * Record a tool call success. Resets the failure count for that key.
 */
export function recordSuccess(
  state: CircuitBreakerState,
  toolName: string,
  args: Record<string, unknown>,
): CircuitBreakerState {
  const key = buildSemanticKey(toolName, args)
  const newFailures = new Map(state.failures)
  newFailures.delete(key)

  // If no failures remain, close the circuit
  const open = [...newFailures.values()].some(c => c >= DEFAULT_FAILURE_THRESHOLD)

  return {
    failures: newFailures,
    open,
    reason: open ? state.reason : undefined,
  }
}

/**
 * Check if a specific tool+args combination is blocked by the circuit breaker.
 */
export function isBlocked(
  state: CircuitBreakerState,
  toolName: string,
  args: Record<string, unknown>,
  threshold: number = DEFAULT_FAILURE_THRESHOLD,
): boolean {
  const key = buildSemanticKey(toolName, args)
  return (state.failures.get(key) ?? 0) >= threshold
}

// ============================================================================
// Budget extension
// ============================================================================

export interface BudgetState {
  /** Base iteration budget. */
  readonly baseBudget: number
  /** Current effective budget (may be extended). */
  readonly effectiveBudget: number
  /** Number of successfully completed steps in the pipeline. */
  readonly completedSteps: number
  /** Total steps in the pipeline. */
  readonly totalSteps: number
  /** Number of budget extensions granted. */
  readonly extensions: number
  /** Max extensions allowed. */
  readonly maxExtensions: number
}

/**
 * Create initial budget state.
 */
export function createBudgetState(baseBudget: number, totalSteps: number): BudgetState {
  return {
    baseBudget,
    effectiveBudget: baseBudget,
    completedSteps: 0,
    totalSteps,
    extensions: 0,
    maxExtensions: 3,
  }
}

/**
 * Check if the pipeline is making progress and grant a budget extension if so.
 *
 * Logic: if completedSteps increased since last check and we haven't exceeded
 * max extensions, add 25% more iterations to the budget.
 */
export function maybeExtendBudget(
  state: BudgetState,
  newCompletedSteps: number,
): BudgetState {
  if (newCompletedSteps <= state.completedSteps) {
    // No progress — don't extend
    return { ...state, completedSteps: newCompletedSteps }
  }

  if (state.extensions >= state.maxExtensions) {
    // Max extensions reached
    return { ...state, completedSteps: newCompletedSteps }
  }

  // Progress detected — extend budget by 25%
  const extension = Math.ceil(state.baseBudget * 0.25)
  return {
    ...state,
    completedSteps: newCompletedSteps,
    effectiveBudget: state.effectiveBudget + extension,
    extensions: state.extensions + 1,
  }
}
