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
export type { DelegateFn, DelegateResult, PipelineExecutorOptions, ToolExecFn } from "./pipeline.js"
export { validatePlan } from "./validate.js"
export type { ValidationResult } from "./validate.js"
export { runDeterministicProbes, runLLMVerification, verify } from "./verifier.js"

// Re-export all types
export type {
    ArtifactRelation, CircuitBreakerState, DeterministicToolStep, DiagnosticCategory, DiagnosticSeverity, EffectClass, ExecutionEnvelope, PipelineResult, PipelineStatus, PipelineStepResult, PipelineStepStatus, Plan, PlanDiagnostic, PlanEdge, PlannerDecision, PlanStep, StepRole, SubagentFailureClass, SubagentTaskStep, VerificationMode, VerifierDecision, VerifierOutcome,
    VerifierStepAssessment, WorkflowStepContract
} from "./types.js"

import { assessDelegationDecision, type DelegationDecisionInput, type DelegationSubagentStepProfile } from "../delegation-decision.js"
import { getCorrectionGuidance, type DelegationOutputValidationCode } from "../delegation-validation.js"
import { buildEscalationInput, resolveEscalation, type EscalationDecision } from "../escalation.js"
import type { LLMClient, Message, Tool } from "../types.js"
import { createBudgetState, maybeExtendBudget } from "./circuit-breaker.js"
import { assessPlannerDecision } from "./decision.js"
import { generatePlan } from "./generate.js"
import type { DelegateFn } from "./pipeline.js"
import { executePipeline } from "./pipeline.js"
import type { PipelineResult, Plan, PlanDiagnostic, PlanStep, SubagentTaskStep, VerifierDecision } from "./types.js"
import { validatePlan } from "./validate.js"
import { verify } from "./verifier.js"

// ============================================================================
// Warning injection — augment step objectives with validation warnings
// ============================================================================

/**
 * Inject validation warnings into the plan's step objectives so child agents
 * receive guidance about potential issues without blocking the pipeline.
 *
 * Mutates step objectives in-place on the (mutable) plan object.
 */
function injectWarningsIntoSteps(plan: Plan, warnings: readonly PlanDiagnostic[]): void {
  // Partition: step-specific warnings go to that step; global ones go to all subagent steps
  const stepWarnings = new Map<string, string[]>()
  const globalWarnings: string[] = []

  for (const w of warnings) {
    if (w.stepName) {
      const arr = stepWarnings.get(w.stepName) ?? []
      arr.push(w.message)
      stepWarnings.set(w.stepName, arr)
    } else {
      globalWarnings.push(w.message)
    }
  }

  for (const step of plan.steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const msgs = [
      ...(stepWarnings.get(sa.name) ?? []),
      ...globalWarnings,
    ]
    if (msgs.length === 0) continue
    const suffix = `\n\n⚠️ VALIDATION WARNINGS (address these in your implementation):\n${msgs.map(m => `- ${m}`).join("\n")}`
    // Mutate objective — plan steps are not deeply frozen
    ;(sa as { objective: string }).objective = sa.objective + suffix
  }
}

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
  const errors = validation.diagnostics.filter(d => d.severity === "error")
  const warnings = validation.diagnostics.filter(d => d.severity === "warning")

  if (!validation.valid) {
    ctx.onTrace?.({
      kind: "planner-validation-failed",
      diagnostics: errors,
    })
    // Only hard-block on errors (structurally broken plans)
    return {
      handled: false,
      plan,
      skipReason: `Validation failed: ${errors.map(d => d.message).join("; ")}`,
    }
  }

  // Inject warnings into step objectives as guidance (plan still runs)
  if (warnings.length > 0) {
    ctx.onTrace?.({
      kind: "planner-validation-warnings",
      warningCount: warnings.length,
      diagnostics: warnings,
    })
    injectWarningsIntoSteps(plan, warnings)
  }

  // Step 3b: Delegation decision gate — safety, economics, hard-block checks
  // Build step profiles for the delegation decision system
  const subagentSteps = plan.steps.filter(
    (s): s is PlanStep & { stepType: "subagent_task" } => s.stepType === "subagent_task",
  )
  const subagentProfiles: DelegationSubagentStepProfile[] = subagentSteps.map((s) => {
    // Map planner's EffectClass to delegation-decision's effectClass
    const effectMap: Record<string, "read_only" | "write" | "mixed"> = {
      readonly: "read_only",
      filesystem_write: "write",
      filesystem_scaffold: "write",
      shell: "mixed",
      mixed: "mixed",
    }
    return {
      name: s.name,
      objective: s.objective,
      dependsOn: s.dependsOn ? [...s.dependsOn] : undefined,
      acceptanceCriteria: [...s.acceptanceCriteria],
      requiredToolCapabilities: [...s.requiredToolCapabilities],
      canRunParallel: s.canRunParallel,
      effectClass: effectMap[s.executionContext.effectClass] ?? "mixed",
    }
  })

  if (subagentProfiles.length > 0) {
    const delegationInput: DelegationDecisionInput = {
      messageText: goal,
      plannerConfidence: decision.score / 10,
      complexityScore: decision.score,
      totalSteps: plan.steps.length,
      synthesisSteps: plan.steps.filter((s) => s.stepType === "deterministic_tool").length,
      subagentSteps: subagentProfiles,
    }

    const delegationDecision = assessDelegationDecision(delegationInput)

    ctx.onTrace?.({
      kind: "planner-delegation-decision",
      shouldDelegate: delegationDecision.shouldDelegate,
      reason: delegationDecision.reason,
      utilityScore: delegationDecision.utilityScore,
      safetyRisk: delegationDecision.safetyRisk,
      confidence: delegationDecision.confidence,
      hardBlockedTaskClass: delegationDecision.hardBlockedTaskClass,
    })

    if (!delegationDecision.shouldDelegate) {
      return {
        handled: false,
        plan,
        skipReason: `Delegation blocked: ${delegationDecision.reason} (utility=${delegationDecision.utilityScore.toFixed(2)}, safety=${delegationDecision.safetyRisk.toFixed(2)})`,
      }
    }
  }

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs contract validation + deterministic probes each round.
  // Retry decisions are made by the escalation graph.
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

  // Pipeline budget tracking (planner/circuit-breaker) — monitor progress
  // across retry attempts and detect when further retries add no value
  let budgetState = createBudgetState(MAX_PIPELINE_RETRIES + 1, plan.steps.length)

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

    // Update pipeline budget state — track progress for extension decisions
    const prevBudget = budgetState
    budgetState = maybeExtendBudget(budgetState, pipelineResult.completedSteps)
    if (budgetState.extensions > prevBudget.extensions) {
      ctx.onTrace?.({
        kind: "planner-budget-extended",
        completedSteps: pipelineResult.completedSteps,
        effectiveBudget: budgetState.effectiveBudget,
        extensions: budgetState.extensions,
      })
    }

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

    // agenc-core pattern: strict retry gating via escalation graph.
    // The escalation graph is a pure deterministic function that maps
    // the current state to a next action: pass/retry/revise/escalate.
    const hasRetryableSteps = verifierDecision.steps.some(
      s => s.outcome !== "pass" && s.retryable !== false,
    )

    // Pre-compute: detect repeated identical failures for escalation input
    let prelimAllStepsRepeatedFailure = true
    for (const stepAssessment of verifierDecision.steps) {
      if (stepAssessment.outcome === "pass") continue
      const issueKey = [...stepAssessment.issues].sort().join("|")
      if (priorStepIssues.get(stepAssessment.stepName) !== issueKey) {
        prelimAllStepsRepeatedFailure = false
        break
      }
    }

    const escalation: EscalationDecision = resolveEscalation(buildEscalationInput({
      verifierOverall: verifierDecision.overall,
      attempt,
      maxAttempts: MAX_PIPELINE_RETRIES + 1,
      hasRetryableSteps,
      allStepsRepeatedFailure: prelimAllStepsRepeatedFailure,
    }))

    ctx.onTrace?.({
      kind: "planner-escalation",
      action: escalation.action,
      reason: escalation.reason,
      attempt: attempt + 1,
    })

    if (escalation.action === "pass" || escalation.action === "escalate") {
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
          // Inject correction guidance for contract validation failures
          const enrichedIssues = [...stepAssessment.issues]
          for (const issue of stepAssessment.issues) {
            const contractMatch = issue.match(/^\[contract:(\w+)\]/)
            if (contractMatch) {
              const code = contractMatch[1] as DelegationOutputValidationCode
              const guidance = getCorrectionGuidance(code)
              if (guidance && !enrichedIssues.includes(`[correction] ${guidance}`)) {
                enrichedIssues.push(`[correction] ${guidance}`)
              }
            }
          }
          retryFeedback.set(stepAssessment.stepName, enrichedIssues)
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

  // If verification didn't pass after all retries, return handled: false so
  // the parent agent can fall through to the direct tool loop and attempt to
  // fix the remaining issues itself — with full knowledge of what's wrong.
  if (verifierDecision!.overall !== "pass") {
    return {
      handled: false,
      answer,
      plan,
      pipelineResult,
      verifierDecision,
      skipReason: "Verification failed after retries — falling through to self-repair",
    }
  }

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

export function synthesizeAnswer(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): string {
  const parts: string[] = []

  if (verifierDecision.overall === "pass") {
    parts.push("All tasks completed and verified successfully.")
  } else if (verifierDecision.overall === "retry") {
    parts.push("Task verification FAILED — the following issues remain unresolved after all retry attempts:")
  } else {
    parts.push("Task FAILED — critical errors prevented completion:")
  }

  parts.push("")
  parts.push(`Plan: ${plan.reason}`)
  parts.push(`Steps: ${pipelineResult.completedSteps}/${pipelineResult.totalSteps} completed`)
  parts.push("")

  for (const step of plan.steps) {
    const result = pipelineResult.stepResults.get(step.name)
    const stepVerification = verifierDecision.steps.find(s => s.stepName === step.name)
    // Reflect verifier assessment in step status — a step that the pipeline
    // marked "completed" but the verifier flagged is NOT truly complete.
    const hasUnresolvedIssues = stepVerification && stepVerification.issues.length > 0 && stepVerification.outcome !== "pass"
    const status = hasUnresolvedIssues ? "incomplete" : (result?.status ?? "unknown")
    const icon = hasUnresolvedIssues ? "⚠" : status === "completed" ? "✓" : status === "failed" ? "✗" : "⊘"
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
