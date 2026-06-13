/**
 * Planner routing decision types.
 *
 * Two execution modes only:
 *   direct  — agent tool loop (default)
 *   planner — structured plan + child agents
 *
 * @module
 */

export type PlannerRoute = "direct" | "planner"

export interface PlannerDecision {
  readonly route: PlannerRoute
  readonly reason: string
  readonly shouldPlan: boolean
  readonly score: number
}

/** Shared contract metadata used in repair envelopes and plan prompts. */
export interface CoherentSharedContract {
  readonly name: string
  readonly description: string
}

/** System invariant metadata used in repair envelopes and plan prompts. */
export interface CoherentSystemInvariant {
  readonly id: string
  readonly description: string
}
