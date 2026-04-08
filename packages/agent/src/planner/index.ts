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
    ArtifactRelation, CircuitBreakerState, DeterministicToolStep, DiagnosticCategory, EffectClass, ExecutionEnvelope, PipelineResult, PipelineStatus, PipelineStepResult, PipelineStepStatus, Plan, PlanDiagnostic, PlanEdge, PlannerDecision, PlanStep, StepRole, SubagentFailureClass, SubagentTaskStep, VerificationMode, VerifierDecision, VerifierOutcome,
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
    steps: plan.steps.map(s => ({ name: s.name, type: s.stepType, dependsOn: s.dependsOn ? [...s.dependsOn] : undefined })),
    edges: plan.edges.map(e => ({ from: e.from, to: e.to })),
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

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs deterministic probes each round; retries only if retryable steps exist.
  const MAX_VERIFIER_ROUNDS = MAX_PIPELINE_RETRIES + 1
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  let retryOpts: {
    priorResults?: Map<string, import("./types.js").PipelineStepResult>
    retryFeedback?: Map<string, string[]>
  } = {}
  let verifierRounds = 0
  // Track issues per step across attempts to detect repeated identical failures
  const priorStepIssues = new Map<string, string>()
  // Track stub-issue count per step across attempts — if count doesn't decrease,
  // the child is stuck and further retries won't help
  const priorStubCounts = new Map<string, number>()

  for (let attempt = 0; attempt <= MAX_PIPELINE_RETRIES; attempt++) {
    if (ctx.signal?.aborted) {
      return { handled: true, answer: "Planner was cancelled.", plan }
    }

    ctx.onTrace?.({
      kind: "planner-pipeline-start",
      attempt: attempt + 1,
      verifierRound: verifierRounds,
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
      { signal: ctx.signal, onTrace: ctx.onTrace },
    )

    ctx.onTrace?.({
      kind: "planner-verification",
      overall: verifierDecision.overall,
      confidence: verifierDecision.confidence,
      verifierRound: verifierRounds + 1,
      steps: verifierDecision.steps.map(s => ({
        stepName: s.stepName,
        outcome: s.outcome,
        issues: s.issues,
      })),
    })

    verifierRounds++

    if (verifierDecision.overall === "pass") {
      break
    }

    // agenc-core pattern: strict retry gating.
    // Only retry if:
    //   1. We haven't exceeded max verifier rounds
    //   2. There are retryable steps
    //   3. Confidence is below threshold OR overall is "retry"
    const hasRetryableSteps = verifierDecision.steps.some(
      s => s.outcome !== "pass" && s.retryable !== false,
    )
    const canRetry = (
      verifierRounds < MAX_VERIFIER_ROUNDS &&
      hasRetryableSteps &&
      (verifierDecision.overall === "retry" || verifierDecision.confidence < 0.65)
    )

    if (!canRetry || attempt === MAX_PIPELINE_RETRIES) {
      // Can't recover: no retryable steps, verifier rounds exhausted, or budget exhausted
      break
    }

    // Build targeted retry context from verifier feedback
    const priorResults = new Map<string, import("./types.js").PipelineStepResult>()
    const retryFeedback = new Map<string, string[]>()
    const NON_RETRYABLE_CLASSES = new Set(["cancelled", "spawn_error"])

    // Detect repeated identical failures — if a step produces the same issues
    // as the previous attempt, further retries won't help (LLM is stuck).
    let allStepsRepeatedFailure = true

    // ── Stub-count regression tracking ──
    // Track the number of stub-related issues per step across retries.
    // If a retry doesn't reduce the stub count, the child is stuck — abort.
    const STUB_KEYWORDS = ["stub", "placeholder", "empty array", "empty object", "returns constant", "catch-all", "trivial return", "empty function"]

    for (const stepAssessment of verifierDecision.steps) {
      const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)

      // Check if this step's issues are identical to the previous attempt
      const issueKey = [...stepAssessment.issues].sort().join("|")
      const prevIssueKey = priorStepIssues.get(stepAssessment.stepName)

      // Count stub-specific issues for regression tracking
      const currentStubCount = stepAssessment.issues.filter(i =>
        STUB_KEYWORDS.some(kw => i.toLowerCase().includes(kw)),
      ).length
      const prevStubCount = priorStubCounts.get(stepAssessment.stepName)

      if (stepAssessment.outcome === "pass" && stepResult) {
        priorResults.set(stepAssessment.stepName, stepResult)
        priorStepIssues.delete(stepAssessment.stepName)
        priorStubCounts.delete(stepAssessment.stepName)
      } else if (stepResult?.failureClass && NON_RETRYABLE_CLASSES.has(stepResult.failureClass)) {
        priorResults.set(stepAssessment.stepName, stepResult)
      } else if (stepAssessment.issues.length > 0) {
        // Check for repeated failure OR stub-count not improving
        const isExactRepeat = prevIssueKey === issueKey
        const stubsNotImproving = prevStubCount !== undefined && currentStubCount >= prevStubCount && currentStubCount > 0

        if (isExactRepeat || stubsNotImproving) {
          ctx.onTrace?.({
            kind: "planner-retry-skip",
            stepName: stepAssessment.stepName,
            reason: isExactRepeat
              ? "Repeated identical failure — further retries won't help"
              : `Stub count not improving (${prevStubCount} → ${currentStubCount}) — child is stuck`,
          })
          if (stepResult) {
            priorResults.set(stepAssessment.stepName, stepResult)
          }
        } else {
          retryFeedback.set(stepAssessment.stepName, [...stepAssessment.issues])
          allStepsRepeatedFailure = false
        }
        priorStepIssues.set(stepAssessment.stepName, issueKey)
        priorStubCounts.set(stepAssessment.stepName, currentStubCount)
      } else {
        allStepsRepeatedFailure = false
      }
    }

    // If every failing step has repeated identical issues, stop retrying entirely
    if (allStepsRepeatedFailure && retryFeedback.size === 0) {
      ctx.onTrace?.({
        kind: "planner-retry-abort",
        reason: "All failing steps have repeated identical issues — aborting retries",
      })
      break
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
