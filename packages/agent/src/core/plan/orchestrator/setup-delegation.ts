import { BanditArmId, DelegationTraceKind } from "../../../domain/index.js"
/**
 * Step 3b of planner setup — delegation gate.
 *
 * Decides HOW a validated plan's subagent steps execute
 * (`PlanExecutionMode`), never WHETHER the plan survives. A plan that
 * reaches this gate has already passed generation + validation (Tier 0);
 * declining delegation economics here changes execution shape — it does
 * NOT discard the plan back to the direct loop. Only a true safety /
 * hard-block finding stops execution.
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
import type { Plan, PlanExecutionMode, PlanStep } from "../types.js"
import { buildPlannerFailurePayload } from "./helpers.js"
import type { PlannerContext, PlannerResult } from "./types.js"

const EFFECT_CLASS_MAP: Record<string, "read_only" | "write" | "mixed"> = {
  readonly: "read_only",
  filesystem_write: "write",
  filesystem_scaffold: "write",
  shell: "mixed",
  mixed: "mixed"
}

/** True safety blocks — execution never starts. */
const DELEGATION_FATAL_REASONS = new Set<DelegationDecisionReason>([
  "safety_risk_high",
  "hard_blocked_task_class"
])

export type DelegationGateOutcome =
  | { readonly blocked: true; readonly result: PlannerResult }
  | {
      readonly blocked: false
      readonly mode: PlanExecutionMode
      readonly banditTrajectory: DelegationTrajectoryRecord | undefined
    }

/**
 * Does this plan's subagent work justify spawning a child even when
 * parallel-fanout economics decline? True when at least one step carries a
 * real contract (explicit tool capabilities or acceptance criteria) rather
 * than being a thin placeholder step.
 */
function hasUsefulSubagentContracts(profiles: readonly DelegationSubagentStepProfile[]): boolean {
  return profiles.some((p) => p.requiredToolCapabilities.length > 0 || p.acceptanceCriteria.length > 0)
}

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

  // No subagent work at all — pipeline runs its deterministic_tool steps
  // only. Mode is moot (nothing to fan out), but parallel is the harmless
  // default since executePipeline's parallelism only matters when
  // subagent_task steps exist.
  if (subagentProfiles.length === 0) {
    return { blocked: false, mode: "parallel", banditTrajectory: undefined }
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

  const isFatal = !delegationDecision.shouldDelegate && DELEGATION_FATAL_REASONS.has(delegationDecision.reason)

  const mode: PlanExecutionMode = isFatal
    ? "stop"
    : delegationDecision.shouldDelegate
      ? "parallel"
      : hasUsefulSubagentContracts(subagentProfiles)
        ? "serial"
        : "guided"

  const traceReason =
    mode === "serial"
      ? `economics_serial: ${delegationDecision.reason}`
      : mode === "guided"
        ? `economics_guided: ${delegationDecision.reason}`
        : delegationDecision.reason

  ctx.onTrace?.({
    kind: DelegationTraceKind.PlannerDecision,
    shouldDelegate: delegationDecision.shouldDelegate,
    reason: traceReason,
    executionMode: mode,
    utilityScore: delegationDecision.utilityScore,
    safetyRisk: delegationDecision.safetyRisk,
    confidence: delegationDecision.confidence,
    hardBlockedTaskClass: delegationDecision.hardBlockedTaskClass,
    banditArmId,
    banditThresholdAdjustment
  })

  if (mode === "stop") {
    const reason = `Delegation declined: ${delegationDecision.reason} (utility=${delegationDecision.utilityScore.toFixed(2)}, safety=${delegationDecision.safetyRisk.toFixed(2)})`
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

  return { blocked: false, mode, banditTrajectory }
}
