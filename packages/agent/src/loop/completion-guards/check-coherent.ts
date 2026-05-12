/**
 * Coherent-verification completion guard. Extracted from completion-guards.ts.
 *
 * @module
 */

import type { CompletionGuardContext, CompletionGuardResult } from "../completion-guards.js"
import {
    buildCoherentPlannerEscalationGoal,
    buildCoherentRepairInstructions,
    summarizeCoherentVerifierDecision,
} from "../../planner/index.js"
import { executePlannerPath } from "../../planner/index.js"

export async function checkCoherentVerification(
  ctx: CompletionGuardContext,
): Promise<CompletionGuardResult | null> {
  const { state, response } = ctx
  const ce = state.coherentExecution
  if (!ce) return null

  const decision = await ctx.runCoherentVerification(false)
  if (!decision) return null

  // Pass → allow immediate completion (bypasses other guards intentionally)
  if (decision.overall === "pass") {
    return {
      tag: "coherent-pass",
      message: "",
      finalAnswer: response.content ?? "(no response)",
    }
  }

  // Fail → attempt repair
  const summary = summarizeCoherentVerifierDecision(decision)
  const nextRepairAttempt = ce.repairAttempts + 1

  ctx.onPlannerTrace?.({
    kind: "coherent-generation-repair-needed",
    repairAttempt: nextRepairAttempt,
    issueCount: summary.issueCount,
    issues: [...summary.issues],
    affectedArtifacts: [...summary.affectedArtifacts],
  })
  ctx.onPlannerTrace?.({
    kind: "planner-architecture-state",
    lane: "bounded_coherent_generation",
    status: "repairing_in_place",
    reason: "coherent_completion_blocked_by_verifier",
    architecture: ce.bundle.architecture,
  })

  // First repair attempt
  if (ce.repairAttempts < 1) {
    ce.repairAttempts = nextRepairAttempt
    const repairMsg = buildCoherentRepairInstructions(ce.bundle, decision, nextRepairAttempt)
    return { tag: "coherent-repair-required", message: repairMsg }
  }

  // Escalation to planner
  if (!ce.escalated && ctx.config.enablePlanner && ctx.config.plannerDelegateFn) {
    ce.escalated = true
    ctx.onPlannerTrace?.({
      kind: "coherent-generation-escalated",
      target: "planner_repair_path",
      issueCount: summary.issueCount,
      reason: "coherent_repair_still_failing",
    })
    ctx.onPlannerTrace?.({
      kind: "planner-architecture-state",
      lane: "bounded_coherent_generation",
      status: "abandoned",
      reason: "coherent_repair_still_failing",
      architecture: ce.bundle.architecture,
    })

    const remediationResult = await executePlannerPath(
      buildCoherentPlannerEscalationGoal(ctx.messages[1]?.content ?? "", ce.bundle, decision),
      ctx.createPlannerContext(),
      ctx.config.plannerDelegateFn,
    )

    if (remediationResult.handled) {
      return {
        tag: "coherent-escalation",
        message: "",
        finalAnswer: remediationResult.answer ?? "(planner remediation produced no answer)",
      }
    }
  }

  // Fallback repair
  ce.repairAttempts = nextRepairAttempt
  const fallbackMsg = buildCoherentRepairInstructions(ce.bundle, decision, nextRepairAttempt)

  // Hard exit after too many repair attempts
  if (nextRepairAttempt > 4) {
    return {
      tag: "coherent-repair-exhausted",
      message: fallbackMsg,
      finalAnswer: response.content ?? "(coherent generation completed — verifier disagreement unresolved)",
    }
  }

  return { tag: "coherent-repair-required", message: fallbackMsg }
}

