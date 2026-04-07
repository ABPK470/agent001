/**
 * Planner orchestrator — the main entry point for planned execution.
 *
 * Flow:
 *   1. assessPlannerDecision() — should we plan? (score >= 3)
 *   2. generatePlan() — ask LLM for structured plan
 *   3. validatePlan() — multi-pass validation with refinement
 *   4. executePipeline() — DAG-ordered step execution
 *   5. verify() — deterministic probes + LLM verification
 *   6. Retry pipeline if verification says "retry" (max 2 retries)
 *
 * @module
 */

export {
    createBudgetState, createCircuitBreaker, isBlocked, maybeExtendBudget, recordFailure,
    recordSuccess
} from "./circuit-breaker.js"
export type { BudgetState } from "./circuit-breaker.js"
export { assessPlannerDecision } from "./decision.js"
export { generatePlan } from "./generate.js"
export type { PlanGenerationContext, PlanGenerationResult } from "./generate.js"
export { executePipeline } from "./pipeline.js"
export type { DelegateFn, PipelineExecutorOptions, ToolExecFn } from "./pipeline.js"
export { validatePlan } from "./validate.js"
export type { ValidationResult } from "./validate.js"
export { runDeterministicProbes, runLLMVerification, verify } from "./verifier.js"

// Re-export all types
export type {
    ArtifactRelation, CircuitBreakerState, DeterministicToolStep, DiagnosticCategory, EffectClass, ExecutionEnvelope, PipelineResult, PipelineStatus, PipelineStepResult, PipelineStepStatus, Plan, PlanDiagnostic, PlanEdge, PlannerDecision, PlanStep, StepRole, SubagentTaskStep, VerificationMode, VerifierDecision, VerifierOutcome,
    VerifierStepAssessment, WorkflowStepContract
} from "./types.js"

import type { LLMClient, Message, Tool } from "../types.js"
import { assessPlannerDecision } from "./decision.js"
import { generatePlan } from "./generate.js"
import type { DelegateFn } from "./pipeline.js"
import { executePipeline } from "./pipeline.js"
import type { PipelineResult, Plan, VerifierDecision } from "./types.js"
import { validatePlan } from "./validate.js"
import { verify } from "./verifier.js"

// ============================================================================
// Main orchestrator
// ============================================================================

export interface PlannerContext {
  /** LLM client. */
  readonly llm: LLMClient
  /** Available tools. */
  readonly tools: readonly Tool[]
  /** Workspace root path. */
  readonly workspaceRoot: string
  /** Conversation history. */
  readonly history: readonly Message[]
  /** Abort signal. */
  readonly signal?: AbortSignal
  /** Called with trace events for UI. */
  readonly onTrace?: (entry: Record<string, unknown>) => void
}

export interface PlannerResult {
  /** Did the planner handle this task? */
  readonly handled: boolean
  /** Final answer if handled. */
  readonly answer?: string
  /** The plan that was generated (for debug/trace). */
  readonly plan?: Plan
  /** Pipeline result (for debug/trace). */
  readonly pipelineResult?: PipelineResult
  /** Verifier decision (for debug/trace). */
  readonly verifierDecision?: VerifierDecision
  /** Reason the planner didn't handle the task (if !handled). */
  readonly skipReason?: string
}

/**
 * Try to handle a task via the planner path.
 *
 * Returns { handled: true, answer } if the planner handled it,
 * or { handled: false, skipReason } if the task should go to the direct tool loop.
 */
export async function executePlannerPath(
  goal: string,
  ctx: PlannerContext,
  delegateFn: DelegateFn,
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2

  // Step 1: Should we plan?
  const decision = assessPlannerDecision(goal, ctx.history)
  ctx.onTrace?.({
    kind: "planner-decision",
    score: decision.score,
    shouldPlan: decision.shouldPlan,
    reason: decision.reason,
  })

  if (!decision.shouldPlan) {
    return { handled: false, skipReason: `score=${decision.score} (${decision.reason})` }
  }

  // Step 2: Generate plan
  ctx.onTrace?.({ kind: "planner-generating" })
  const genResult = await generatePlan(ctx.llm, {
    goal,
    availableTools: ctx.tools,
    workspaceRoot: ctx.workspaceRoot,
    history: ctx.history,
  }, {
    maxAttempts: 3,
    signal: ctx.signal,
  })

  if (!genResult.plan) {
    ctx.onTrace?.({
      kind: "planner-generation-failed",
      diagnostics: genResult.diagnostics,
    })
    return {
      handled: false,
      skipReason: `Plan generation failed: ${genResult.diagnostics.map(d => d.message).join("; ")}`,
    }
  }

  const plan = genResult.plan
  ctx.onTrace?.({
    kind: "planner-plan-generated",
    reason: plan.reason,
    stepCount: plan.steps.length,
    steps: plan.steps.map(s => ({ name: s.name, type: s.stepType })),
  })

  // Step 3: Validate plan
  const validation = validatePlan(plan, ctx.tools)
  if (!validation.valid) {
    ctx.onTrace?.({
      kind: "planner-validation-failed",
      diagnostics: validation.diagnostics,
    })
    // If validation fails, fall back to direct tool loop rather than blocking
    return {
      handled: false,
      plan,
      skipReason: `Validation failed: ${validation.diagnostics.map(d => d.message).join("; ")}`,
    }
  }

  // Step 4: Execute pipeline (with retry)
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  let retryOpts: {
    priorResults?: Map<string, import("./types.js").PipelineStepResult>
    retryFeedback?: Map<string, string[]>
  } = {}

  for (let attempt = 0; attempt <= MAX_PIPELINE_RETRIES; attempt++) {
    if (ctx.signal?.aborted) {
      return { handled: true, answer: "Planner was cancelled.", plan }
    }

    ctx.onTrace?.({
      kind: "planner-pipeline-start",
      attempt: attempt + 1,
      maxRetries: MAX_PIPELINE_RETRIES + 1,
    })

    pipelineResult = await executePipeline(
      plan,
      ctx.tools as Tool[],
      delegateFn,
      {
        maxParallel: 4,
        workspaceRoot: ctx.workspaceRoot,
        priorResults: retryOpts.priorResults,
        retryFeedback: retryOpts.retryFeedback,
        signal: ctx.signal,
        onStepStart: (step) => ctx.onTrace?.({
          kind: "planner-step-start",
          stepName: step.name,
          stepType: step.stepType,
        }),
        onStepEnd: (step, result) => ctx.onTrace?.({
          kind: "planner-step-end",
          stepName: step.name,
          status: result.status,
          durationMs: result.durationMs,
        }),
      },
    )

    ctx.onTrace?.({
      kind: "planner-pipeline-end",
      status: pipelineResult.status,
      completedSteps: pipelineResult.completedSteps,
      totalSteps: pipelineResult.totalSteps,
    })

    // Step 5: Verify
    verifierDecision = await verify(
      ctx.llm,
      plan,
      pipelineResult,
      ctx.tools as Tool[],
      { signal: ctx.signal },
    )

    ctx.onTrace?.({
      kind: "planner-verification",
      overall: verifierDecision.overall,
      confidence: verifierDecision.confidence,
      steps: verifierDecision.steps.map(s => ({
        stepName: s.stepName,
        outcome: s.outcome,
        issues: s.issues,
      })),
    })

    if (verifierDecision.overall === "pass") {
      break
    }

    // Accept "retry" with sufficient confidence — the pipeline completed and issues are minor
    if (verifierDecision.overall === "retry"
      && verifierDecision.confidence >= 0.65
      && pipelineResult.status === "completed") {
      ctx.onTrace?.({
        kind: "planner-retry-skipped",
        reason: `confidence ${verifierDecision.confidence.toFixed(2)} >= 0.65 with completed pipeline — accepting`,
      })
      break
    }

    if (verifierDecision.overall === "fail" || attempt === MAX_PIPELINE_RETRIES) {
      // Can't recover
      break
    }

    // Build targeted retry context from verifier feedback
    const priorResults = new Map<string, import("./types.js").PipelineStepResult>()
    const retryFeedback = new Map<string, string[]>()
    for (const stepAssessment of verifierDecision.steps) {
      const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)
      if (stepAssessment.outcome === "pass" && stepResult) {
        // Reuse verified-pass step results — don't re-run them
        priorResults.set(stepAssessment.stepName, stepResult)
      } else if (stepAssessment.issues.length > 0) {
        // Send verifier feedback to steps that need retry
        retryFeedback.set(stepAssessment.stepName, [...stepAssessment.issues])
      }
    }

    ctx.onTrace?.({
      kind: "planner-retry",
      attempt: attempt + 1,
      reason: verifierDecision.unresolvedItems.join("; "),
      skippedSteps: priorResults.size,
      retrySteps: retryFeedback.size,
    })

    // Store retry context for next iteration
    retryOpts = { priorResults, retryFeedback }
  }

  // Step 6: Synthesize final answer
  const answer = synthesizeAnswer(plan, pipelineResult!, verifierDecision!)
  return {
    handled: true,
    answer,
    plan,
    pipelineResult,
    verifierDecision,
  }
}

// ============================================================================
// Answer synthesis
// ============================================================================

function synthesizeAnswer(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): string {
  const parts: string[] = []

  if (verifierDecision.overall === "pass") {
    parts.push("All tasks completed and verified successfully.")
  } else if (verifierDecision.overall === "retry") {
    parts.push("Tasks completed with some issues that could not be fully resolved.")
  } else {
    parts.push("Some tasks failed to complete successfully.")
  }

  parts.push("")
  parts.push(`Plan: ${plan.reason}`)
  parts.push(`Steps: ${pipelineResult.completedSteps}/${pipelineResult.totalSteps} completed`)
  parts.push("")

  for (const step of plan.steps) {
    const result = pipelineResult.stepResults.get(step.name)
    const status = result?.status ?? "unknown"
    const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "⊘"
    parts.push(`${icon} ${step.name} (${step.stepType}): ${status}`)

    // Include output summary for completed subagent tasks
    if (result?.output && step.stepType === "subagent_task") {
      const summary = result.output.slice(0, 200)
      parts.push(`  → ${summary}${result.output.length > 200 ? "..." : ""}`)
    }

    // Include errors for failed steps
    if (result?.error) {
      parts.push(`  ⚠ ${result.error.slice(0, 200)}`)
    }

    // Include verifier issues
    const stepVerification = verifierDecision.steps.find(s => s.stepName === step.name)
    if (stepVerification && stepVerification.issues.length > 0) {
      for (const issue of stepVerification.issues) {
        parts.push(`  ! ${issue}`)
      }
    }
  }

  if (verifierDecision.unresolvedItems.length > 0) {
    parts.push("")
    parts.push("Unresolved:")
    for (const item of verifierDecision.unresolvedItems) {
      parts.push(`  - ${item}`)
    }
  }

  return parts.join("\n")
}
