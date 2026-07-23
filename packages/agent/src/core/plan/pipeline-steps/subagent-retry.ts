/**
 * Subagent step — mandatory-retry path triggered when the first attempt
 * lacks file-mutation evidence (or fails the BLUEPRINT contract). Issues
 * a sharper objective, re-delegates, and re-validates.
 *
 * @module
 */

import {
  buildBlueprintRetryGuidance,
  isBlueprintLikeStep,
  type SubagentStepValidationContext
} from "../internal/pipeline-repair.js"
import { validateSubagentCompletion } from "../pipeline-validation/index.js"
import type { DelegateFn } from "../pipeline/index.js"
import type { PipelineStepResult, SubagentTaskStep } from "../types.js"
import { asChildExecution, asToolCallRecords } from "../internal/delegate-result.js"

export interface MandatoryRetryInput {
  readonly step: SubagentTaskStep
  readonly originalFailureMessage: string
  readonly delegateFn: DelegateFn
  readonly validationCtx: SubagentStepValidationContext | undefined
  readonly t0: number
}

export async function runSubagentMandatoryRetry(input: MandatoryRetryInput): Promise<PipelineStepResult> {
  const { step, originalFailureMessage, delegateFn, validationCtx, t0 } = input
  const blueprintRepairBlock =
    validationCtx && isBlueprintLikeStep(step)
      ? `\n\n[MANDATORY RETRY — BLUEPRINT CONTRACT REPAIR]\n${buildBlueprintRetryGuidance(step, validationCtx.plan, [originalFailureMessage])}`
      : ""

  const retryStep: SubagentTaskStep = {
    ...step,
    objective:
      `${step.objective}\n\n` +
      `[MANDATORY RETRY — WRITE EVIDENCE REQUIRED]\n` +
      `You must create or modify the target artifacts in this attempt.\n` +
      `Use write_file (or replace_in_file after reading the existing file) on the exact target paths.\n` +
      `Do not stop at analysis or narrative summary. Produce real file mutations before finishing.` +
      blueprintRepairBlock
  }

  const retryResult = await delegateFn(retryStep, retryStep.executionContext)
  const retryOutput = retryResult.output
  const retryCalls = asToolCallRecords(retryResult.toolCalls)
  const childExec = asChildExecution(retryResult.execution)

  if (retryOutput.startsWith("Delegation failed:")) {
    const isSpawnError = retryOutput.includes("not found") || retryOutput.includes("spawn")
    return failed(
      step,
      retryOutput,
      isSpawnError ? "spawn_error" : "unknown",
      "rejected",
      t0,
      retryCalls,
      childExec
    )
  }
  if (retryOutput.includes("DELEGATION INCOMPLETE")) {
    return failed(step, retryOutput, "budget_exceeded", "repair_required", t0, retryCalls, childExec)
  }
  if (retryOutput.includes("stuck in a tool loop")) {
    return failed(step, retryOutput, "tool_misuse", "repair_required", t0, retryCalls, childExec)
  }

  const retryStrictFailure = await validateSubagentCompletion(step, retryOutput, retryCalls, validationCtx)
  if (!retryStrictFailure) {
    return {
      name: step.name,
      status: "completed",
      executionState: "executed",
      acceptanceState: "pending_verification",
      output: retryOutput,
      durationMs: Date.now() - t0,
      toolCalls: retryCalls,
      childResult: childExec,
      producedArtifacts: childExec?.producedArtifacts,
      modifiedArtifacts: childExec?.modifiedArtifacts,
      verificationAttempts: childExec?.verificationAttempts
    }
  }

  return {
    name: step.name,
    status: "failed",
    executionState: "failed",
    acceptanceState: "repair_required",
    error: retryStrictFailure.message,
    failureClass:
      isBlueprintLikeStep(step) && /BLUEPRINT/i.test(retryStrictFailure.message)
        ? "blueprint_contract"
        : "unknown",
    durationMs: Date.now() - t0,
    toolCalls: retryCalls,
    childResult: childExec,
    producedArtifacts: childExec?.producedArtifacts,
    modifiedArtifacts: childExec?.modifiedArtifacts,
    verificationAttempts: childExec?.verificationAttempts,
    validationCode: retryStrictFailure.code
  }
}

function failed(
  step: SubagentTaskStep,
  error: string,
  failureClass: PipelineStepResult["failureClass"],
  acceptanceState: PipelineStepResult["acceptanceState"],
  t0: number,
  toolCalls: PipelineStepResult["toolCalls"],
  childExec: PipelineStepResult["childResult"]
): PipelineStepResult {
  return {
    name: step.name,
    status: "failed",
    executionState: "failed",
    acceptanceState,
    error,
    failureClass,
    durationMs: Date.now() - t0,
    toolCalls,
    childResult: childExec,
    producedArtifacts: childExec?.producedArtifacts,
    modifiedArtifacts: childExec?.modifiedArtifacts,
    verificationAttempts: childExec?.verificationAttempts
  }
}
