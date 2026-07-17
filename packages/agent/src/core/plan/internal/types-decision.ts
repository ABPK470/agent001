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
