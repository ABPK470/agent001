import { BanditArmId, DelegationTraceKind } from "../../../domain/index.js"
/**
 * Step 3b of planner setup — delegation decision gate.
 *
 * Decides whether child-agent delegation economics justify running the
 * planner pipeline. When economics decline, the caller falls back to the
 * direct tool loop — declining subagent fan-out is not a fatal planner error.
 *
 * @module
 */

import {
  assessDelegationDecision,
  type DelegationDecisionInput,
  type DelegationDecisionReason,
  type DelegationSubagentStepProfile
} from "../../../core/delegate-decision/index.js"
import type { DelegationBanditTuner, DelegationTrajectoryRecord } from "../../../runtime/delegate.js"
import type { Plan, PlanStep } from "../types.js"
import { buildPlannerFailurePayload } from "./helpers.js"
import type { PlannerContext, PlannerResult } from "./types.js"

const EFFECT_CLASS_MAP: Record<string, "read_only" | "write" | "mixed"> = {
  readonly: "read_only",
  filesystem_write: "write",
  filesystem_scaffold: "write",
  shell: "mixed",
  mixed: "mixed"
}

/** True safety blocks — never fall back to direct loop. */
const DELEGATION_FATAL_REASONS = new Set<DelegationDecisionReason>([
  "safety_risk_high",
  "hard_blocked_task_class"
])

export type DelegationGateOutcome =
  | { readonly blocked: true; readonly result: PlannerResult }
  | { readonly blocked: false; readonly banditTrajectory: DelegationTrajectoryRecord | undefined }

export function runDelegationGate(
  plan: Plan,
  goal: string,
  decision: { route: string; score: number; reason: string },
  ctx: PlannerContext,
  banditTuner: DelegationBanditTuner | undefined
): DelegationGateOutcome {
  const subagentSteps = plan.steps.filter(
    (s): s is PlanStep & { stepType: "subagent_task" } => s.stepType === "subagent_task"
  )
  const subagentProfiles: DelegationSubagentStepProfile[] = subagentSteps.map((s) => ({
    name: s.name,
    objective: s.objective,
    dependsOn: s.dependsOn ? [...s.dependsOn] : undefined,
    acceptanceCriteria: [...s.acceptanceCriteria],
    requiredToolCapabilities: [...s.requiredToolCapabilities],
    canRunParallel: s.canRunParallel,
    effectClass: EFFECT_CLASS_MAP[s.executionContext.effectClass] ?? "mixed"
  }))

  if (subagentProfiles.length === 0) {
    return { blocked: false, banditTrajectory: undefined }
  }

  let banditArmId: BanditArmId | undefined
  let banditThresholdAdjustment = 0
  if (banditTuner) {
    banditArmId = banditTuner.selectArm()
    banditThresholdAdjustment = banditTuner.getThresholdAdjustment(banditArmId)
  }

  const delegationInput: DelegationDecisionInput = {
    messageText: goal,
    plannerConfidence: decision.score / 10,
    complexityScore: decision.score,
    totalSteps: plan.steps.length,
    synthesisSteps: plan.steps.filter((s) => s.stepType === "deterministic_tool").length,
    subagentSteps: subagentProfiles,
    explicitDelegationRequested: decision.route === "planner",
    config: banditThresholdAdjustment !== 0 ? { scoreThreshold: 0.2 + banditThresholdAdjustment } : undefined
  }

  const delegationDecision = assessDelegationDecision(delegationInput)

  let banditTrajectory: DelegationTrajectoryRecord | undefined
  if (banditTuner && banditArmId) {
    banditTrajectory = banditTuner.buildTrajectory({
      armId: banditArmId,
      appliedThreshold: 0.2 + banditThresholdAdjustment,
      complexityScore: decision.score,
      fanoutCount: subagentProfiles.length,
      stepCount: plan.steps.length,
      nestingDepth: 1,
      parallelFraction:
        subagentProfiles.filter((s) => s.canRunParallel).length / Math.max(1, subagentProfiles.length),
      shouldDelegate: delegationDecision.shouldDelegate,
      utilityScore: delegationDecision.utilityScore
    })
  }

  ctx.onTrace?.({
    kind: DelegationTraceKind.PlannerDecision,
    shouldDelegate: delegationDecision.shouldDelegate,
    reason: delegationDecision.reason,
    utilityScore: delegationDecision.utilityScore,
    safetyRisk: delegationDecision.safetyRisk,
    confidence: delegationDecision.confidence,
    hardBlockedTaskClass: delegationDecision.hardBlockedTaskClass,
    banditArmId,
    banditThresholdAdjustment
  })

  if (!delegationDecision.shouldDelegate) {
    const reason = `Delegation declined: ${delegationDecision.reason} (utility=${delegationDecision.utilityScore.toFixed(2)}, safety=${delegationDecision.safetyRisk.toFixed(2)})`

    if (DELEGATION_FATAL_REASONS.has(delegationDecision.reason)) {
      return {
        blocked: true,
        result: {
          handled: true,
          answer: buildPlannerFailurePayload({
            stage: "delegation",
            reason,
            diagnostics: [
              {
                utilityScore: delegationDecision.utilityScore,
                safetyRisk: delegationDecision.safetyRisk,
                reason: delegationDecision.reason
              }
            ],
            score: decision.score,
            plannerReason: decision.reason
          }),
          plan,
          skipReason: reason
        }
      }
    }

    // Economics declined child delegation — parent direct loop can still answer.
    return {
      blocked: true,
      result: {
        handled: false,
        plan,
        skipReason: reason
      }
    }
  }

  return { blocked: false, banditTrajectory }
}
