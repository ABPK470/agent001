/**
 * Planner-first routing — the logic that attempts structured planning
 * before falling through to the direct tool loop.
 *
 * Handles: coherent generation, planner path execution, delay commitment,
 * remediation, and verification-driven fallback routing.
 */

import type { AgentLoopState } from "./agent-loop-state.js"
import * as log from "./logger.js"
import { assessPlannerDecision } from "./planner/decision.js"
import type { PlannerContext } from "./planner/index.js"
import { executePlannerPath } from "./planner/index.js"
import type { VerifierDecision } from "./planner/types.js"
import { attemptCoherentGeneration } from "./planner-routing/coherent-generation.js"
import { handleVerificationFailure } from "./planner-routing/verification-failure.js"
import type { ToolCallRecord } from "./tool-result.js"
import type { AgentConfig, LLMClient, Message, TokenUsage, Tool } from "./types.js"

/** Result of planner-first routing. */
export interface PlannerRoutingResult {
  /** If set, the planner handled the entire goal — return this as the final answer. */
  finalAnswer?: string
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
  /** Increment llmCalls counter. */
  incrementLlmCalls: () => void
  /** Create a PlannerContext. */
  createPlannerContext: () => PlannerContext
  /** Run coherent verification. */
  runCoherentVerification: (force?: boolean) => Promise<VerifierDecision | null>
}

/**
 * Attempt planner-first routing. Returns a final answer if the planner
 * handles the entire goal, otherwise returns undefined (fall through
 * to the direct tool loop).
 */
export async function attemptPlannerRouting(
  ctx: PlannerRoutingContext,
): Promise<PlannerRoutingResult> {
  const { goal, messages, config } = ctx

  if (!config.enablePlanner || !config.plannerDelegateFn) return {}
  const routingDecision = await assessPlannerDecision(goal, messages, ctx.llm, config.signal)
  config.onPlannerTrace?.({
    kind: "planner-decision",
    score: routingDecision.score,
    shouldPlan: routingDecision.shouldPlan,
    route: routingDecision.route,
    reason: routingDecision.reason,
    coherenceNeed: routingDecision.coherenceNeed,
    coordinationNeed: routingDecision.coordinationNeed,
  })

  if (routingDecision.route === "direct" || routingDecision.route === "single_artifact_direct_burst") {
    config.onPlannerTrace?.({
      kind: "direct_loop_fallback",
      source: "planner_declined",
      reason: `route=${routingDecision.route} score=${routingDecision.score} (${routingDecision.reason})`,
    })
    return {}
  }

  if (routingDecision.route !== "bounded_coherent_generation") {
    config.onPlannerTrace?.({ kind: "planning_preflight", mode: "planner-first" })
  }
  const plannerCtx = ctx.createPlannerContext()

  // ── Execute planner path ──
  const plannerResult = routingDecision.route === "bounded_coherent_generation"
    ? { handled: false as const }
    : await executePlannerPath(goal, plannerCtx, config.plannerDelegateFn)

  if (plannerResult.handled) {
    const answer = plannerResult.answer ?? "(planner produced no answer)"
    if (config.verbose) log.logFinalAnswer(answer)
    return { finalAnswer: answer }
  }

  let coherentGenerationFailed = false

  // ── Coherent generation path ──
  if (routingDecision.route === "bounded_coherent_generation") {
    let coherentResult: { failed: boolean }
    try {
      coherentResult = await attemptCoherentGeneration(ctx, routingDecision.route)
    } catch (err) {
      // HTTP 422/413 (context too large), 429 (rate limit), network errors, etc.
      // Treat as a failed coherent gen and fall through to the full planner.
      config.onPlannerTrace?.({
        kind: "coherent-generation-failed",
        stage: "llm_error",
        diagnostics: [String(err)],
      })
      coherentResult = { failed: true }
    }
    if (coherentResult.failed) {
      coherentGenerationFailed = true
    }
  }

  // ── Delay commitment: coherent failed → escalate to planner ──
  if (coherentGenerationFailed && config.plannerDelegateFn) {
    config.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: "full_planner_decomposition",
      status: "repairing_in_place",
      reason: "coherent_generation_failed_escalating_to_planner",
    })
    const escalatedResult = await executePlannerPath(
      goal, plannerCtx, config.plannerDelegateFn,
      { forceRoute: "full_planner_decomposition" },
    )
    if (escalatedResult.handled) {
      const answer = escalatedResult.answer ?? "(planner produced no answer)"
      if (config.verbose) log.logFinalAnswer(answer)
      return { finalAnswer: answer }
    }
  }

  // ── Planner declined — handle verification failures ──
  if (config.verbose && plannerResult.skipReason) {
    log.logError(`Planner skipped: ${plannerResult.skipReason}`)
  }

  if (plannerResult.verifierDecision && plannerResult.verifierDecision.overall !== "pass") {
    const remediationAnswer = await handleVerificationFailure(
      ctx, plannerResult, plannerCtx,
    )
    if (remediationAnswer) {
      return { finalAnswer: remediationAnswer }
    }
  }

  if (routingDecision.route !== "bounded_coherent_generation") {
    config.onPlannerTrace?.({
      kind: "direct_loop_fallback",
      source: "planner_declined",
      reason: plannerResult.skipReason ?? "Planner declined — continuing in the direct tool loop.",
    })
  }

  return {}
}

// Internal helpers extracted to ./planner-routing/coherent-generation.ts and ./planner-routing/verification-failure.ts
