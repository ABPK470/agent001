import { PlannerTraceKind, VerifierOutcome } from "../../domain/index.js"
/**
 * Phase-0 delegation contract validation. Returns contractFailures detected
 * before LLM verification needs to run.
 *
 * @module
 */

import {
    buildContractSpec,
    getCorrectionGuidance,
    validateDelegatedOutputContract,
} from "../../delegation/index.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierStepAssessment,
} from "../types.js"

export interface ContractCheckOptions {
  knownProjectArtifacts: readonly string[]
  onTrace?: (entry: Record<string, unknown>) => void
}

export function runContractValidation(
  plan: Plan,
  pipelineResult: PipelineResult,
  opts: ContractCheckOptions,
): VerifierStepAssessment[] {
  const contractFailures: VerifierStepAssessment[] = []

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const stepResult = pipelineResult.stepResults.get(step.name)
    if (!stepResult || stepResult.status === "skipped") continue

    const contractSpec = buildContractSpec(
      sa,
      sa.executionContext,
      undefined,
      opts.knownProjectArtifacts,
    )
    const contractResult = validateDelegatedOutputContract({
      spec: contractSpec,
      output: stepResult.output ?? stepResult.error ?? "",
      toolCalls: stepResult.toolCalls,
    })

    if (stepResult.reconciliation && !stepResult.reconciliation.compliant) {
      contractFailures.push({
        stepName: step.name,
        outcome: VerifierOutcome.Retry,
        confidence: 0.97,
        issues: stepResult.reconciliation.findings.map((finding) => `[reconciliation:${finding.code}] ${finding.message}`),
        retryable: true,
      })
      opts.onTrace?.({
        kind: PlannerTraceKind.VerifierReconciliation,
        stepName: step.name,
        findings: stepResult.reconciliation.findings.map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message })),
      })
      continue
    }

    if (!contractResult.ok && contractResult.code) {
      const guidance = getCorrectionGuidance(contractResult.code)
      contractFailures.push({
        stepName: step.name,
        outcome: VerifierOutcome.Retry,
        confidence: 0.95,
        issues: [
          `[contract:${contractResult.code}] ${contractResult.message}`,
          `[correction] ${guidance}`,
        ],
        retryable: true,
      })
      opts.onTrace?.({
        kind: PlannerTraceKind.VerifierContractCheck,
        stepName: step.name,
        code: contractResult.code,
        message: contractResult.message,
      })
    }
  }

  return contractFailures
}
