/**
 * Pipeline step execution — deterministic tool calls and subagent delegation
 * with validation, retry, and post-step syntax checking.
 *
 * Extracted from pipeline.ts for maintainability.
 *
 * @module
 */

import {
    buildBlueprintRetryGuidance,
    isBlueprintLikeStep,
    type SubagentStepValidationContext,
} from "./pipeline-repair.js"
import {
    runPostStepSyntaxValidation,
    validateSubagentCompletion,
} from "./pipeline-validation.js"
import type { DelegateFn, ToolExecFn } from "./pipeline.js"
import type {
    DeterministicToolStep,
    PipelineStepResult,
    PlanStep,
    SubagentTaskStep,
} from "./types.js"

// ============================================================================
// Step dispatch
// ============================================================================

export async function executeStep(
  step: PlanStep,
  toolExecFn: ToolExecFn,
  delegateFn: DelegateFn,
  signal?: AbortSignal,
  validationCtx?: SubagentStepValidationContext,
): Promise<PipelineStepResult> {
  const t0 = Date.now()

  if (step.stepType === "deterministic_tool") {
    return executeDeterministicStep(step, toolExecFn, t0, signal)
  } else {
    return executeSubagentStep(step, delegateFn, t0, signal, validationCtx)
  }
}

// ============================================================================
// Deterministic tool step
// ============================================================================

async function executeDeterministicStep(
  step: DeterministicToolStep,
  toolExecFn: ToolExecFn,
  t0: number,
  signal?: AbortSignal,
): Promise<PipelineStepResult> {
  const maxRetries = step.maxRetries ?? 2
  let lastError: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "rejected",
        error: "Aborted",
        durationMs: Date.now() - t0,
      }
    }

    try {
      let args = step.args
      if (step.tool === "browser_check" && !args.path && (args.key || args.url)) {
        args = { ...args, path: String(args.key ?? args.url) }
        delete (args as Record<string, unknown>).key
        delete (args as Record<string, unknown>).url
      }

      let output = await toolExecFn(step.tool, args)

      if (
        step.tool === "write_file" &&
        typeof args.path === "string" &&
        /EISDIR|illegal operation on a directory/i.test(output) &&
        String(args.content ?? "").trim().length === 0
      ) {
        const mkdirCmd = `mkdir -p ${JSON.stringify(String(args.path))}`
        const mkdirOutput = await toolExecFn("run_command", { command: mkdirCmd })
        if (!mkdirOutput.startsWith("Error:")) {
          output = `Recovered directory scaffold via run_command: ${mkdirCmd}`
        }
      }

      if (output.startsWith("Error:")) {
        lastError = output
        continue
      }

      return {
        name: step.name,
        status: "completed",
        executionState: "executed",
        acceptanceState: "accepted",
        output,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    name: step.name,
    status: "failed",
    executionState: "failed",
    acceptanceState: "rejected",
    error: lastError ?? "Unknown error",
    durationMs: Date.now() - t0,
  }
}

// ============================================================================
// Subagent task step
// ============================================================================

async function executeSubagentStep(
  step: SubagentTaskStep,
  delegateFn: DelegateFn,
  t0: number,
  signal?: AbortSignal,
  validationCtx?: SubagentStepValidationContext,
): Promise<PipelineStepResult> {
  if (signal?.aborted) {
    return { name: step.name, status: "failed", error: "Aborted", failureClass: "cancelled", durationMs: Date.now() - t0 }
  }

  try {
    const delegateResult = await delegateFn(step, step.executionContext)
    const output = delegateResult.output
    const childToolCalls = delegateResult.toolCalls
    const childExecution = delegateResult.execution

    if (output.startsWith("Delegation failed:")) {
      const isSpawnError = output.includes("not found") || output.includes("spawn")
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "rejected",
        error: output,
        failureClass: isSpawnError ? "spawn_error" : "unknown",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
      }
    }

    if (output.includes("DELEGATION INCOMPLETE")) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "repair_required",
        error: output,
        failureClass: "budget_exceeded",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
      }
    }

    if (output.includes("stuck in a tool loop")) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "repair_required",
        error: output,
        failureClass: "tool_misuse",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
      }
    }

    if (output.includes("cancelled") || output.includes("aborted")) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "rejected",
        error: output,
        failureClass: "cancelled",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
      }
    }

    const strictFailure = await validateSubagentCompletion(
      step,
      output,
      childToolCalls,
      validationCtx,
    )
    if (strictFailure) {
      if (
        (strictFailure.code === "missing_file_mutation_evidence"
          || (isBlueprintLikeStep(step) && /BLUEPRINT/i.test(strictFailure.message))) &&
        step.executionContext.targetArtifacts.length > 0
      ) {
        const blueprintRepairBlock = validationCtx && isBlueprintLikeStep(step)
          ? `\n\n[MANDATORY RETRY — BLUEPRINT CONTRACT REPAIR]\n${buildBlueprintRetryGuidance(step, validationCtx.plan, [strictFailure.message])}`
          : ""
        const retryStep: SubagentTaskStep = {
          ...step,
          objective:
            `${step.objective}\n\n` +
            `[MANDATORY RETRY — WRITE EVIDENCE REQUIRED]\n` +
            `You must create or modify the target artifacts in this attempt.\n` +
            `Use write_file (or replace_in_file after reading the existing file) on the exact target paths.\n` +
            `Do not stop at analysis or narrative summary. Produce real file mutations before finishing.` +
            blueprintRepairBlock,
        }

        const retryResult = await delegateFn(retryStep, retryStep.executionContext)
        const retryOutput = retryResult.output
        const retryCalls = retryResult.toolCalls

        if (retryOutput.startsWith("Delegation failed:")) {
          const isSpawnError = retryOutput.includes("not found") || retryOutput.includes("spawn")
          return {
            name: step.name,
            status: "failed",
            executionState: "failed",
            acceptanceState: "rejected",
            error: retryOutput,
            failureClass: isSpawnError ? "spawn_error" : "unknown",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
            childResult: retryResult.execution,
            producedArtifacts: retryResult.execution?.producedArtifacts,
            modifiedArtifacts: retryResult.execution?.modifiedArtifacts,
            verificationAttempts: retryResult.execution?.verificationAttempts,
          }
        }
        if (retryOutput.includes("DELEGATION INCOMPLETE")) {
          return {
            name: step.name,
            status: "failed",
            executionState: "failed",
            acceptanceState: "repair_required",
            error: retryOutput,
            failureClass: "budget_exceeded",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
            childResult: retryResult.execution,
            producedArtifacts: retryResult.execution?.producedArtifacts,
            modifiedArtifacts: retryResult.execution?.modifiedArtifacts,
            verificationAttempts: retryResult.execution?.verificationAttempts,
          }
        }
        if (retryOutput.includes("stuck in a tool loop")) {
          return {
            name: step.name,
            status: "failed",
            executionState: "failed",
            acceptanceState: "repair_required",
            error: retryOutput,
            failureClass: "tool_misuse",
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
            childResult: retryResult.execution,
            producedArtifacts: retryResult.execution?.producedArtifacts,
            modifiedArtifacts: retryResult.execution?.modifiedArtifacts,
            verificationAttempts: retryResult.execution?.verificationAttempts,
          }
        }

        const retryStrictFailure = await validateSubagentCompletion(
          step,
          retryOutput,
          retryCalls,
          validationCtx,
        )
        if (!retryStrictFailure) {
          return {
            name: step.name,
            status: "completed",
            executionState: "executed",
            acceptanceState: "pending_verification",
            output: retryOutput,
            durationMs: Date.now() - t0,
            toolCalls: retryCalls,
            childResult: retryResult.execution,
            producedArtifacts: retryResult.execution?.producedArtifacts,
            modifiedArtifacts: retryResult.execution?.modifiedArtifacts,
            verificationAttempts: retryResult.execution?.verificationAttempts,
          }
        }

        return {
          name: step.name,
          status: "failed",
          executionState: "failed",
          acceptanceState: "repair_required",
          error: retryStrictFailure.message,
          failureClass: isBlueprintLikeStep(step) && /BLUEPRINT/i.test(retryStrictFailure.message) ? "blueprint_contract" : "unknown",
          durationMs: Date.now() - t0,
          toolCalls: retryCalls,
          childResult: retryResult.execution,
          producedArtifacts: retryResult.execution?.producedArtifacts,
          modifiedArtifacts: retryResult.execution?.modifiedArtifacts,
          verificationAttempts: retryResult.execution?.verificationAttempts,
          validationCode: retryStrictFailure.code,
        }
      }

      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "repair_required",
        error: strictFailure.message,
        failureClass: isBlueprintLikeStep(step) && /BLUEPRINT/i.test(strictFailure.message) ? "blueprint_contract" : "unknown",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
        validationCode: strictFailure.code,
      }
    }

    // ── Post-step syntax validation ──
    const syntaxErrors = await runPostStepSyntaxValidation(
      step,
      childToolCalls ?? [],
      validationCtx,
    )
    if (syntaxErrors.length > 0) {
      return {
        name: step.name,
        status: "failed",
        executionState: "failed",
        acceptanceState: "repair_required",
        error: `Syntax validation failed after step completion:\n${syntaxErrors.join("\n")}`,
        failureClass: "syntax_error",
        durationMs: Date.now() - t0,
        toolCalls: childToolCalls,
        childResult: childExecution,
        producedArtifacts: childExecution?.producedArtifacts,
        modifiedArtifacts: childExecution?.modifiedArtifacts,
        verificationAttempts: childExecution?.verificationAttempts,
      }
    }

    return {
      name: step.name,
      status: "completed",
      executionState: "executed",
      acceptanceState: "pending_verification",
      output,
      durationMs: Date.now() - t0,
      toolCalls: childToolCalls,
      childResult: childExecution,
      producedArtifacts: childExecution?.producedArtifacts,
      modifiedArtifacts: childExecution?.modifiedArtifacts,
      verificationAttempts: childExecution?.verificationAttempts,
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isTransient = /ECONNRESET|ETIMEDOUT|rate.?limit|429|503|overloaded/i.test(errMsg)
    return {
      name: step.name,
      status: "failed",
      executionState: "failed",
      acceptanceState: "rejected",
      error: errMsg,
      failureClass: isTransient ? "transient_provider_error" : "unknown",
      durationMs: Date.now() - t0,
    }
  }
}
