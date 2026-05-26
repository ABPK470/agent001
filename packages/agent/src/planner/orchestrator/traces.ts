import { PlannerRepairCompatibilityMode, PlannerTraceKind, VerifierOutcome } from "../../domain/index.js"
/**
 * Trace-emission helpers for the planner orchestrator.
 *
 * Each helper is a pure side-effect function that fans out one cluster
 * of `ctx.onTrace?.(...)` calls. Extracted from orchestrate.ts to keep
 * the main retry loop focused on control flow rather than telemetry.
 *
 * @module
 */

import type { PipelineResult, Plan, RepairPlan, RepairPlanCompatibilityReport, VerifierDecision } from "../types.js"
import type { PlannerContext } from "./types.js"

/** Result of the regression/retry-prep helper. Subset used by trace helpers. */
export interface RegressionTraceInput {
  readonly priorResults: ReadonlyMap<string, unknown>
  readonly retryableTaskCount: number
  readonly activeRepairPlan: RepairPlan
}

export interface PipelineCallbacks {
  readonly onStepStart: (step: { name: string; stepType: string }) => void
  readonly onStepEnd: (
    step: { name: string },
    result: import("../types.js").PipelineStepResult,
  ) => void
}

/** Build the per-step trace callbacks passed into executePipeline. */
export function buildPipelineCallbacks(ctx: PlannerContext, attempt: number): PipelineCallbacks {
  return {
    onStepStart: (step) =>
      ctx.onTrace?.({
        kind: PlannerTraceKind.StepStart,
        stepName: step.name,
        stepType: step.stepType as never,
      }),
    onStepEnd: (step, result) => {
      ctx.onTrace?.({
        kind: PlannerTraceKind.StepEnd,
        stepName: step.name,
        status: result.status,
        executionState: result.executionState,
        acceptanceState: result.acceptanceState,
        durationMs: result.durationMs,
        error: result.error,
        validationCode: result.validationCode,
        producedArtifacts: result.producedArtifacts,
        verificationAttempts: result.verificationAttempts,
        reconciliation: result.reconciliation
          ? {
              compliant: result.reconciliation.compliant,
              findings: result.reconciliation.findings.map((finding) => ({
                code: finding.code,
                severity: finding.severity,
                message: finding.message,
              })),
            }
          : undefined,
      })
      ctx.onTrace?.({
        kind: PlannerTraceKind.StepTransition,
        attempt: attempt + 1,
        stepName: step.name,
        phase: "execution",
        state: result.acceptanceState ?? result.status,
        timestamp: Date.now(),
      })
    },
  }
}

/** Emit the cluster of verification-result traces. */
export function emitVerificationTraces(
  ctx: PlannerContext,
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
  routeDecisionRoute: string,
  attempt: number,
  verifierRoundIndex: number,
): void {
  ctx.onTrace?.({
    kind: PlannerTraceKind.Verification,
    overall: verifierDecision.overall,
    confidence: verifierDecision.confidence,
    verifierRound: verifierRoundIndex,
    systemChecks: verifierDecision.systemChecks?.map((check) => ({
      code: check.code,
      severity: check.severity,
      summary: check.summary,
      confidence: check.confidence,
    })),
    steps: verifierDecision.steps.map(s => ({
      stepName: s.stepName,
      outcome: s.outcome,
      issues: s.issues,
      issueCodes: s.issueDetails?.map(issue => issue.code) ?? [],
      ownershipModes: s.issueDetails?.map(issue => issue.ownershipMode) ?? [],
      issueConfidences: s.issueDetails?.map(issue => issue.confidence) ?? [],
      acceptanceState: pipelineResult?.stepResults.get(s.stepName)?.acceptanceState,
    })),
  })
  if (plan.coherentBootstrap) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.ArchitectureState,
      lane: plan.route ?? routeDecisionRoute,
      status: verifierDecision.overall === VerifierOutcome.Pass ? "preserved" : "repairing_in_place",
      reason: verifierDecision.overall === VerifierOutcome.Pass ? "verification_passed" : "architecture_preserving_repair",
      architecture: plan.coherentBootstrap.architecture,
    })
  }
  ctx.onTrace?.({
    kind: PlannerTraceKind.IssueTimeline,
    attempt: attempt + 1,
    verifierRound: verifierRoundIndex,
    issues: verifierDecision.steps.flatMap((step) => (step.issueDetails ?? []).map((issue) => ({
      stepName: step.stepName,
      code: issue.code,
      confidence: issue.confidence,
      ownershipMode: issue.ownershipMode,
      primaryOwner: issue.primaryOwner,
      suspectedOwners: [...issue.suspectedOwners],
    }))),
  })
  for (const step of verifierDecision.steps) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.StepTransition,
      attempt: attempt + 1,
      stepName: step.stepName,
      phase: "verification",
      state: pipelineResult?.stepResults.get(step.stepName)?.acceptanceState ?? step.outcome,
      timestamp: Date.now(),
    })
  }
}

export interface RepairPlanTraceInput {
  readonly attempt: number
  readonly verifierDecision: VerifierDecision
  readonly repairCompatibility: RepairPlanCompatibilityReport
  readonly activeCompatibilityPath: "legacy" | "repair"
  readonly compatibilityMode: "legacy" | "shadow" | "repair"
  readonly legacyPinnedForRun: boolean
  readonly compatibilityThreshold: number
}

/** Emit the cluster of repair-plan / compatibility traces. */
export function emitRepairPlanTraces(ctx: PlannerContext, input: RepairPlanTraceInput): void {
  const {
    attempt,
    verifierDecision,
    repairCompatibility,
    activeCompatibilityPath,
    compatibilityMode,
    legacyPinnedForRun,
    compatibilityThreshold,
  } = input
  ctx.onTrace?.({
    kind: PlannerTraceKind.RepairPlan,
    attempt: attempt + 1,
    epoch: attempt + 1,
    rerunOrder: verifierDecision.repairPlan?.rerunOrder ?? [],
    tasks: (verifierDecision.repairPlan as RepairPlan | undefined)?.tasks.map(task => ({
      stepName: task.stepName,
      mode: task.mode,
      ownedIssueCodes: task.ownedIssues.map(issue => issue.code),
      dependencyIssueCodes: task.dependencyContext.map(issue => issue.code),
    })) ?? [],
  })
  ctx.onTrace?.({
    kind: PlannerTraceKind.RepairCompatibility,
    attempt: attempt + 1,
    mode: repairCompatibility.mode,
    activePath: activeCompatibilityPath,
    diverged: repairCompatibility.diverged,
    divergenceScore: repairCompatibility.divergenceScore,
    divergenceThreshold: compatibilityThreshold,
    pinnedToLegacy: compatibilityMode === PlannerRepairCompatibilityMode.Shadow && legacyPinnedForRun,
    reasons: [...repairCompatibility.reasons],
    legacy: {
      rerunOrder: repairCompatibility.legacyPlan.rerunOrder,
      tasks: repairCompatibility.legacyPlan.tasks.map((task) => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
      })),
    },
    repair: {
      rerunOrder: repairCompatibility.repairPlan.rerunOrder,
      tasks: repairCompatibility.repairPlan.tasks.map((task) => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
        dependencyIssueCodes: task.dependencyContext.map((issue) => issue.code),
      })),
    },
  })
}

/** Emit the retry intent trace + per-task transition traces. */
export function emitRetryTraces(
  ctx: PlannerContext,
  attempt: number,
  verifierDecision: VerifierDecision,
  regression: RegressionTraceInput,
): void {
  ctx.onTrace?.({
    kind: PlannerTraceKind.Retry,
    attempt: attempt + 1,
    reason: verifierDecision.unresolvedItems.join("; "),
    skippedSteps: regression.priorResults.size,
    retrySteps: regression.retryableTaskCount,
    rerunOrder: regression.activeRepairPlan.rerunOrder,
  })
  for (const task of regression.activeRepairPlan.tasks) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.StepTransition,
      attempt: attempt + 1,
      stepName: task.stepName,
      phase: "repair",
      state: task.mode,
      timestamp: Date.now(),
    })
  }
}
