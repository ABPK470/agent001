/**
 * Planner routing decision types.
 *
 * Two-tier model — these are DIFFERENT questions, decided at different times:
 *
 *   Tier 0 — PlannerRoute (this file, decided by `assessPlannerDecision`
 *     BEFORE any plan exists): should this goal be structurally planned at
 *     all, or handled by the direct tool loop?
 *       direct  — agent tool loop (default)
 *       planner — structured plan + child agents
 *
 *   Tier 1 — PlanExecutionMode (decided by `runDelegationGate` AFTER a plan
 *     has been generated and validated): once a plan exists, HOW should its
 *     subagent steps run? A generated plan is never discarded back to the
 *     direct loop here — economics only change execution shape, not whether
 *     the plan survives. See `setup-delegation.ts`.
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

/**
 * Tier 1 execution mode — how a validated plan's subagent steps run.
 *
 *   parallel_children — economics approved delegation; fan out up to the
 *     pipeline's parallelism cap.
 *   serial_children   — economics declined fan-out, but the plan's subagent
 *     steps carry real contracts (tool capabilities / acceptance criteria);
 *     still spawn children, one at a time.
 *   parent_guided      — economics declined fan-out and the subagent steps
 *     are thin; spawn children serially with full parent tool access
 *     instead of a tight per-step allowlist, to minimize spawn friction.
 *   stop               — safety / hard-block gate fired; execution never
 *     starts (the caller returns a blocked `PlannerResult`, not this mode).
 */
export type PlanExecutionMode = "parallel_children" | "serial_children" | "parent_guided" | "stop"
