/**
 * Planner routing decision types.
 *
 * Two-tier model — these are DIFFERENT questions, decided at different times:
 *
 *   Tier 0 — PlannerRoute (`assessPlannerDecision`, BEFORE any plan exists):
 *     does this goal need a structured plan at all?
 *       direct  — parent tool loop (no plan)
 *       planner — generate and KEEP a plan
 *
 *   Tier 1 — PlanExecutionMode (`runDelegationGate`, AFTER a valid plan):
 *     how should that plan's `subagent_task` steps run?
 *     Economics never discards the plan back to the direct loop — it only
 *     picks parallelism / tool-scoping shape. See `setup-delegation.ts`.
 *
 * Vocabulary (do not conflate):
 *   - A *plan step* is a unit of work in the plan (not a tool).
 *   - `deterministic_tool` step = call one named tool with fixed args.
 *   - `subagent_task` step = spawn a child agent loop for that objective.
 *   - Tools are what agents *call*; steps are what the *plan* schedules.
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
 * Tier 1 — how a validated plan's `subagent_task` steps execute.
 *
 *   parallel — economics ok; fan out up to the pipeline parallelism cap
 *   serial   — economics declined fan-out; still spawn children, one at a time,
 *              with normal per-step envelopes
 *   guided   — economics declined and steps look thin; still spawn serially,
 *              but with the parent's full tool set (looser allowlist)
 *   stop     — safety / hard-block; execution never starts
 */
export type PlanExecutionMode = "parallel" | "serial" | "guided" | "stop"
