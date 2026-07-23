/**
 * Planner-first routing — try structured planning before the direct tool loop.
 *
 * @module
 */

import { PlannerTraceKind } from "../../domain/index.js"
import * as log from "../../internal/index.js"
import type { ToolCallRecord } from "../../tools/_shared/result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../../domain/types/agent-types.js"
import type { AgentLoopState } from "../../domain/types/agent-loop-state.js"
import type { PlannerContext } from "../plan.js"
import { assessPlannerDecision, executePlannerPath } from "../plan.js"

export interface PlannerRoutingResult {
  readonly finalAnswer?: string
}

export interface PlannerRoutingContext {
  goal: string
  messages: Message[]
  state: AgentLoopState
  llm: LLMClient
  toolList: Tool[]
  tools: Map<string, Tool>
  config: {
    enablePlanner: boolean
    workspaceRoot: string
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    signal: AgentConfig["signal"]
    verbose: boolean
    onPlannerTrace: AgentConfig["onPlannerTrace"]
    onLlmCall: AgentConfig["onLlmCall"]
    onNudge: AgentConfig["onNudge"]
  }
  usage: TokenUsage
  allToolCalls: ToolCallRecord[]
  incrementLlmCalls: () => void
  createPlannerContext: () => PlannerContext
}

/**
 * Attempt planner routing. Returns a final answer when the planner fully
 * handles the goal; otherwise the caller continues in the direct tool loop.
 *
 * Two-tier model — these decide DIFFERENT questions:
 *   Tier 0 (assessPlannerDecision) — structure only: does this goal need a
 *     plan at all? Cheap goal-class routing; data queries, edits, and
 *     dialogue skip planner entirely and stay on the direct loop.
 *   Tier 1 (runDelegationGate, post-plan, inside executePlannerPath) —
 *     execution mode only: given a validated plan, how do its subagent
 *     steps run (parallel / serial / parent-guided)? A plan that reaches
 *     Tier 1 is ALWAYS kept and executed — economics never discard it
 *     back to the direct loop.
 *
 * `DirectLoopFallback` traces therefore only ever fire here for Tier 0
 * (`route=direct` or planner disabled) — never for Tier 1 economics.
 */
export async function attemptPlannerRouting(ctx: PlannerRoutingContext): Promise<PlannerRoutingResult> {
  const { goal, config } = ctx

  if (!config.enablePlanner || !config.plannerDelegateFn) return {}

  const decision = assessPlannerDecision(goal, ctx.messages)
  config.onPlannerTrace?.({
    kind: PlannerTraceKind.Decision,
    score: decision.score,
    shouldPlan: decision.shouldPlan,
    route: decision.route,
    reason: decision.reason
  })

  if (decision.route === "direct") {
    config.onPlannerTrace?.({
      kind: PlannerTraceKind.DirectLoopFallback,
      source: "planner_declined",
      reason: `route=direct (${decision.reason})`
    })
    return {}
  }

  config.onPlannerTrace?.({ kind: PlannerTraceKind.PlanningPreflight, mode: "planner-first" })

  const result = await executePlannerPath(goal, ctx.createPlannerContext(), config.plannerDelegateFn, {
    decision
  })

  if (result.handled) {
    const answer = result.answer ?? "(planner produced no answer)"
    if (config.verbose) log.logFinalAnswer(answer)
    return { finalAnswer: answer }
  }

  // Defensive backstop only — `runPlannerSetup` returns `handled: false` here
  // solely when Tier 0 already said `shouldPlan: false`, which the `route
  // === "direct"` branch above already short-circuits. Should not happen in
  // practice; if it does, this is NOT an economics decline (those keep the
  // plan and pick a PlanExecutionMode instead — see setup-delegation.ts).
  if (config.verbose && result.skipReason) {
    log.logError(`Planner skipped: ${result.skipReason}`)
  }

  config.onPlannerTrace?.({
    kind: PlannerTraceKind.DirectLoopFallback,
    source: "planner_unhandled",
    reason: result.skipReason ?? "Planner declined — continuing in the direct tool loop."
  })

  return {}
}
