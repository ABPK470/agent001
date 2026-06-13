/**
 * Planner-first routing — try structured planning before the direct tool loop.
 *
 * @module
 */

import { PlannerTraceKind } from "../../../domain/index.js"
import * as log from "../../../internal/index.js"
import type { ToolCallRecord } from "../../../tools/index.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "../../../domain/agent-types.js"
import type { AgentLoopState } from "../../shell/loop.js"
import type { PlannerContext } from "../planner.js"
import { assessPlannerDecision, executePlannerPath } from "../planner.js"

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

  if (config.verbose && result.skipReason) {
    log.logError(`Planner skipped: ${result.skipReason}`)
  }

  config.onPlannerTrace?.({
    kind: PlannerTraceKind.DirectLoopFallback,
    source: "planner_declined",
    reason: result.skipReason ?? "Planner declined — continuing in the direct tool loop."
  })

  return {}
}
