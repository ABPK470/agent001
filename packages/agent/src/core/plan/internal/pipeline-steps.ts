import { DelegationOutputValidationCode, PipelineStatus } from "../../../domain/index.js"
/**
 * Pipeline step execution — deterministic tool calls and subagent delegation
 * with validation, retry, and post-step syntax checking.
 *
 * Submodules:
 *   pipeline-steps/deterministic.ts    — executeDeterministicStep
 *   pipeline-steps/subagent-retry.ts   — runSubagentMandatoryRetry
 *
 * @module
 */

import { executeDeterministicStep } from "../pipeline-steps/deterministic.js"
import { runSubagentMandatoryRetry } from "../pipeline-steps/subagent-retry.js"
import { runPostStepSyntaxValidation, validateSubagentCompletion } from "../pipeline-validation/index.js"
import type { DelegateFn, ToolExecFn } from "../pipeline/index.js"
import { detectPlatformUnconfigured } from "../platform-errors.js"
import type { PipelineStepResult, PlanStep, SubagentTaskStep } from "../types.js"
import { asChildExecution, asToolCallRecords } from "./delegate-result.js"
import { isBlueprintLikeStep, type SubagentStepValidationContext } from "./pipeline-repair.js"

// ============================================================================
// Step dispatch
// ============================================================================

export async function executeStep(
  step: PlanStep,
  toolExecFn: ToolExecFn,
  delegateFn: DelegateFn,
  signal?: AbortSignal,
  validationCtx?: SubagentStepValidationContext
): Promise<PipelineStepResult> {
  const t0 = Date.now()

  if (step.stepType === "deterministic_tool") {
    return executeDeterministicStep(step, toolExecFn, t0, signal)
  }
  return executeSubagentStep(step, delegateFn, t0, signal, validationCtx)
}

// ============================================================================
// Subagent task step
// ============================================================================

async function executeSubagentStep(
  step: SubagentTaskStep,
  delegateFn: DelegateFn,
  t0: number,
  signal?: AbortSignal,
  validationCtx?: SubagentStepValidationContext
): Promise<PipelineStepResult> {
  if (signal?.aborted) {
    return {
      name: step.name,
      status: PipelineStatus.Failed,
      error: "Aborted",
      failureClass: "cancelled",
      durationMs: Date.now() - t0
    }
  }

  try {
    const delegateResult = await delegateFn(step, step.executionContext)
    const output = delegateResult.output
    const childToolCalls = asToolCallRecords(delegateResult.toolCalls)
    const childExecution = asChildExecution(delegateResult.execution)

    // Platform-unconfigured short-circuit (subagent path). If the child's
    // narrative output OR any of its tool-call results contain the missing
    // platform-config marker, treat the whole step as unrecoverable.
    const subagentTexts = [output, ...(childToolCalls?.map((c) => c.result) ?? [])]
    for (const text of subagentTexts) {
      if (typeof text !== "string") continue
      if (detectPlatformUnconfigured(text)) {
        return failed(step, text, "platform_unconfigured", "rejected", t0, childToolCalls, childExecution)
      }
    }

    if (output.startsWith("Delegation failed:")) {
      const isSpawnError = output.includes("not found") || output.includes("spawn")
      return failed(
        step,
        output,
        isSpawnError ? "spawn_error" : "unknown",
        "rejected",
        t0,
        childToolCalls,
        childExecution
      )
    }
    if (output.includes("DELEGATION INCOMPLETE")) {
      return failed(step, output, "budget_exceeded", "repair_required", t0, childToolCalls, childExecution)
    }
    if (output.includes("stuck in a tool loop")) {
      return failed(step, output, "tool_misuse", "repair_required", t0, childToolCalls, childExecution)
    }
    if (output.includes("cancelled") || output.includes("aborted")) {
      return failed(step, output, "cancelled", "rejected", t0, childToolCalls, childExecution)
    }

    const strictFailure = await validateSubagentCompletion(step, output, childToolCalls, validationCtx)
    if (strictFailure) {
      // Trigger a single mandatory-retry path when the step required file
      // mutations (or BLUEPRINT contract) but produced none.
      const eligibleForRetry =
        (strictFailure.code === DelegationOutputValidationCode.MissingFileMutationEvidence ||
          (isBlueprintLikeStep(step) && /BLUEPRINT/i.test(strictFailure.message))) &&
        step.executionContext.targetArtifacts.length > 0
      if (eligibleForRetry) {
        return runSubagentMandatoryRetry({
          step,
          originalFailureMessage: strictFailure.message,
          delegateFn,
          validationCtx,
          t0
        })
      }

      return {
        name: step.name,
        status: PipelineStatus.Failed,
        executionState: "failed",
        acceptanceState: "repair_required",
        error: strictFailure.message,
        failureClass:
          isBlueprintLikeStep(step) && /BLUEPRINT/i.test(strictFailure.message)
            ? "blueprint_contract"
            : "unknown",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
        validationCode: strictFailure.code
      }
    }

    // ── Post-step syntax validation ──
    const syntaxErrors = await runPostStepSyntaxValidation(step, childToolCalls ?? [], validationCtx)
    if (syntaxErrors.length > 0) {
      return {
        name: step.name,
        status: PipelineStatus.Failed,
        executionState: "failed",
        acceptanceState: "repair_required",
        error: `Syntax validation failed after step completion:\n${syntaxErrors.join("\n")}`,
        failureClass: "syntax_error",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts
      }
    }

    return {
      name: step.name,
      status: PipelineStatus.Completed,
      executionState: "executed",
      acceptanceState: "pending_verification",
      output,
      durationMs: Date.now() - t0,
      toolCalls: childToolCalls,
      childResult: childExecution,
      producedArtifacts: childExecution?.producedArtifacts,
      modifiedArtifacts: childExecution?.modifiedArtifacts,
      verificationAttempts: childExecution?.verificationAttempts
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isTransient = /ECONNRESET|ETIMEDOUT|rate.?limit|429|503|overloaded/i.test(errMsg)
    return {
      name: step.name,
      status: PipelineStatus.Failed,
      executionState: "failed",
      acceptanceState: "rejected",
      error: errMsg,
      failureClass: isTransient ? "transient_provider_error" : "unknown",
      durationMs: Date.now() - t0
    }
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
    status: PipelineStatus.Failed,
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
