/**
 * Planner orchestrator — the main `executePlannerPath` entry point.
 *
 * Extracted from index.ts to keep file sizes manageable.
 * @module
 */

import { assessDelegationDecision, type DelegationDecisionInput, type DelegationSubagentStepProfile } from "../delegation-decision.js"
import { buildEscalationInput, resolveEscalation, type EscalationDecision } from "../escalation.js"
import type { LLMClient, Message, Tool } from "../types.js"
import { createBudgetState, maybeExtendBudget } from "./circuit-breaker.js"
import { assessPlannerDecision } from "./decision.js"
import { generateCoherentBootstrap, generatePlan } from "./generate.js"
import { injectBlueprintStep, strengthenExistingBlueprintSteps } from "./index-blueprint.js"
import {
    applyWarningAutoFixes,
    inferForcedOutputDirectoryFromGoal,
    injectBrowserRuntimeContracts,
    injectHelperDependencyContracts,
    injectSharedStateOwnershipContract,
    injectVisualStyleContracts,
    injectWarningsIntoSteps,
    normalizePlanOutputDirectory,
    remediateValidationErrors,
} from "./index-normalize.js"
import { synthesizeAnswer } from "./index-synthesize.js"
import type { DelegateFn } from "./pipeline.js"
import { executePipeline } from "./pipeline.js"
import { compilePlannerRuntime } from "./runtime-model.js"
import type { PipelineResult, Plan, PlannerCoherentBootstrap, PlannerRepairCompatibilityMode, PlanStep, RepairPlan, VerifierDecision } from "./types.js"
import { validatePlan } from "./validate.js"
import { buildIssueIdentity, buildLegacyRetryPlan, buildRepairPlan, compareRepairPlanCompatibility, deriveAcceptanceState } from "./verification-model.js"
import { verify } from "./verifier.js"

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
  /**
   * Optional delegation bandit tuner.
   * When provided, UCB1 arm selection adjusts the effective score threshold
   * for delegation decisions and records outcomes for online learning.
   */
  readonly delegationBanditTuner?: import("../delegation-learning.js").DelegationBanditTuner
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

function resolvePlannerCompatibilityMode(): PlannerRepairCompatibilityMode {
  const raw = (process.env["AGENT_PLANNER_COMPAT_MODE"] ?? "shadow").trim().toLowerCase()
  if (raw === "legacy" || raw === "repair" || raw === "shadow") return raw
  return "shadow"
}

function resolvePlannerCompatibilityThreshold(): number {
  const raw = Number(process.env["AGENT_PLANNER_COMPAT_THRESHOLD"] ?? 3)
  if (!Number.isFinite(raw)) return 3
  return Math.max(1, Math.floor(raw))
}

function applyVerificationAcceptanceStates(
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): PipelineResult {
  const nextResults = new Map(pipelineResult.stepResults)

  for (const assessment of verifierDecision.steps) {
    const result = nextResults.get(assessment.stepName)
    if (!result) continue
    const hasBlueprintContractIssue = (assessment.issueDetails ?? []).some((issue) => issue.repairClass === "contract_drift" && /blueprint|spec/i.test(issue.summary))
    nextResults.set(assessment.stepName, {
      ...result,
      acceptanceState: deriveAcceptanceState(assessment, result.acceptanceState),
      failureClass: hasBlueprintContractIssue ? "blueprint_contract" : result.failureClass,
    })
  }

  return {
    ...pipelineResult,
    stepResults: nextResults,
  }
}

function buildPlannerFailurePayload(params: {
  stage: "generation" | "validation" | "delegation"
  reason: string
  diagnostics?: readonly unknown[]
  score?: number
  plannerReason?: string
}): string {
  return JSON.stringify({
    kind: "planner_failure",
    stage: params.stage,
    reason: params.reason,
    diagnostics: params.diagnostics ?? [],
    score: params.score ?? null,
    plannerReason: params.plannerReason ?? null,
    requiresDirectLoopFallback: false,
    action: "stop_and_request_plan_remediation",
  }, null, 2)
}

/**
 * Try to handle a task via the planner path.
 *
 * Returns { handled: true, answer } if the planner handled it,
 * or { handled: false, skipReason } if the task should go to the direct tool loop.
 *
 * Important: once a task is accepted into structured planning, unrepaired plan
 * validation failures are treated as terminal planner failures rather than
 * downgrading into the direct loop. Falling back after detecting an invalid
 * multi-step plan causes the exact overwrite regressions the validator exists
 * to prevent.
 *
 * @param options.forceRoute — skip routing assessment and force a specific planner
 *   route. Used by delay-commitment fallback when coherent generation fails.
 */
export async function executePlannerPath(
  goal: string,
  ctx: PlannerContext,
  delegateFn: DelegateFn,
  options?: { forceRoute?: "full_planner_decomposition" | "planner_with_coherent_bootstrap" },
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2

  // Bandit tuner trajectory tracked across the function scope so we can
  // record the outcome at any of the final return sites.
  const banditTuner = ctx.delegationBanditTuner
  let banditTrajectory: import("../delegation-learning.js").DelegationTrajectoryRecord | undefined
  const pipelineStartMs = Date.now()

  // Step 1: Should we plan?
  // When forceRoute is set (delay-commitment fallback from coherent failure),
  // skip the routing assessment and commit directly to the specified route.
  const decision = options?.forceRoute != null
    ? {
        shouldPlan: true,
        route: options.forceRoute,
        score: 10,
        reason: "coherent_generation_fallback_escalation",
        coherenceNeed: "high" as const,
        coordinationNeed: "medium" as const,
        routingConfidence: "lean_planner" as const,
        llmClassified: false,
      }
    : await assessPlannerDecision(goal, ctx.history, ctx.llm, ctx.signal)
  ctx.onTrace?.({
    kind: "planner-decision",
    score: decision.score,
    shouldPlan: decision.shouldPlan,
    route: decision.route,
    reason: decision.reason,
    coherenceNeed: decision.coherenceNeed,
    coordinationNeed: decision.coordinationNeed,
  })

  if (!decision.shouldPlan) {
    return { handled: false, skipReason: `route=${decision.route} score=${decision.score} (${decision.reason})` }
  }

  let coherentBootstrap: PlannerCoherentBootstrap | undefined
  if (decision.route === "planner_with_coherent_bootstrap") {
    const bootstrapResult = await generateCoherentBootstrap(ctx.llm, {
      goal,
      workspaceRoot: ctx.workspaceRoot,
      history: ctx.history,
    }, {
      signal: ctx.signal,
    })

    if (!bootstrapResult.bootstrap) {
      ctx.onTrace?.({
        kind: "planner-generation-failed",
        diagnostics: bootstrapResult.diagnostics,
      })
      const reason = `Planner bootstrap failed: ${bootstrapResult.diagnostics.map((d) => d.message).join("; ")}`
      return {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "generation",
          reason,
          diagnostics: bootstrapResult.diagnostics,
          score: decision.score,
          plannerReason: decision.reason,
        }),
        skipReason: reason,
      }
    }

    coherentBootstrap = bootstrapResult.bootstrap
    ctx.onTrace?.({
      kind: "planner-coherent-bootstrap",
      artifactCount: coherentBootstrap.artifacts.length,
      decompositionStrategy: coherentBootstrap.decompositionStrategy,
      decompositionReasons: [...coherentBootstrap.decompositionReasons],
      sharedContracts: coherentBootstrap.sharedContracts?.map((contract) => contract.name) ?? [],
      invariants: coherentBootstrap.invariants?.map((invariant) => invariant.id) ?? [],
    })
    ctx.onTrace?.({
      kind: "planner-architecture-state",
      lane: decision.route,
      status: "frozen",
      reason: "coherent_bootstrap_generated",
      architecture: coherentBootstrap.architecture,
    })
  }

  // Step 2: Generate plan
  ctx.onTrace?.({ kind: "planner-generating" })
  const genResult = await generatePlan(ctx.llm, {
    goal,
    availableTools: ctx.tools,
    workspaceRoot: ctx.workspaceRoot,
    history: ctx.history,
    route: decision.route,
    coherentBootstrap,
  }, {
    maxAttempts: 3,
    signal: ctx.signal,
  })

  if (!genResult.plan) {
    ctx.onTrace?.({
      kind: "planner-generation-failed",
      diagnostics: genResult.diagnostics,
    })
    const reason = `Plan generation failed: ${genResult.diagnostics.map(d => d.message).join("; ")}`
    return {
      handled: true,
      answer: buildPlannerFailurePayload({
        stage: "generation",
        reason,
        diagnostics: genResult.diagnostics,
        score: decision.score,
        plannerReason: decision.reason,
      }),
      skipReason: reason,
    }
  }

  const plan = genResult.plan

  const forcedOutputDir = inferForcedOutputDirectoryFromGoal(goal)
  if (forcedOutputDir) {
    normalizePlanOutputDirectory(plan, forcedOutputDir)
    ctx.onTrace?.({ kind: "planner-output-root-forced", outputRoot: forcedOutputDir })
  }

  ctx.onTrace?.({
    kind: "planner-plan-generated",
    reason: plan.reason,
    stepCount: plan.steps.length,
    steps: plan.steps.map(s => ({ name: s.name, type: s.stepType, dependsOn: s.dependsOn ? [...s.dependsOn] : undefined })),
    edges: plan.edges.map(e => ({ from: e.from, to: e.to })),
  })

  // Step 3: Validate plan
  let validation = validatePlan(plan, ctx.tools)
  let errors = validation.diagnostics.filter(d => d.severity === "error")
  let warnings = validation.diagnostics.filter(d => d.severity === "warning")

  if (!validation.valid) {
    const remediated = remediateValidationErrors(plan, errors)
    if (remediated) {
      const after = validatePlan(plan, ctx.tools)
      if (after.valid) {
        validation = after
        errors = validation.diagnostics.filter(d => d.severity === "error")
        warnings = validation.diagnostics.filter(d => d.severity === "warning")
        ctx.onTrace?.({ kind: "planner-validation-remediated", diagnostics: validation.diagnostics })
      }
    }
  }

  if (!validation.valid) {
    ctx.onTrace?.({
      kind: "planner-validation-failed",
      diagnostics: errors,
    })
    const reason = `Validation failed: ${errors.map(d => d.message).join("; ")}`
    return {
      handled: true,
      answer: buildPlannerFailurePayload({
        stage: "validation",
        reason,
        diagnostics: errors,
        score: decision.score,
        plannerReason: decision.reason,
      }),
      plan,
      skipReason: reason,
    }
  }

  // Always canonicalize output directory usage before execution.
  // This prevents late path mismatch failures caused by mixed bare-path
  // vs subdirectory artifacts across steps.
  normalizePlanOutputDirectory(plan, forcedOutputDir ?? undefined)

  // Inject warnings into step objectives as guidance (plan still runs)
  if (warnings.length > 0) {
    applyWarningAutoFixes(plan, warnings)
    ctx.onTrace?.({
      kind: "planner-validation-warnings",
      warningCount: warnings.length,
      diagnostics: warnings,
    })
    injectWarningsIntoSteps(plan, warnings)
  }

  // Global hardening: for multi-file JS plans, enforce one explicit shared
  // state owner and propagate a typed contract to all writer steps.
  injectSharedStateOwnershipContract(plan)
  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)

  // Contract-First Architecture: auto-inject a blueprint step as step 0 for
  // multi-file projects. This step generates a BLUEPRINT.md with function
  // signatures, data types, and inter-file contracts that all implementation
  // steps must follow. This prevents Variable Drift across child agents.
  injectBlueprintStep(plan, ctx.workspaceRoot, forcedOutputDir)
  strengthenExistingBlueprintSteps(plan, ctx.workspaceRoot, forcedOutputDir)
  const runtimeModel = compilePlannerRuntime(plan)

  ctx.onTrace?.({
    kind: "planner-runtime-compiled",
    executionSteps: [...runtimeModel.executionGraph.values()].map((node) => ({
      stepName: node.stepName,
      dependsOn: [...node.dependsOn],
      downstream: [...node.downstream],
    })),
    ownershipArtifacts: [...runtimeModel.ownershipGraph.values()].map((node) => ({
      artifactPath: node.artifactPath,
      ownerStepName: node.ownerStepName,
      consumerStepNames: [...node.consumerStepNames],
    })),
    runtimeEntities: runtimeModel.runtimeEntities,
  })

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
    // ── Bandit tuner: select arm and adjust threshold ──────────────────────
    let banditArmId: import("../delegation-learning.js").BanditArmId | undefined
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
      // When the planner already chose full_planner_decomposition, this IS an explicit
      // delegation decision — weight decompositionBenefit accordingly.
      explicitDelegationRequested: decision.route === "full_planner_decomposition",
      config: banditThresholdAdjustment !== 0 ? { scoreThreshold: 0.2 + banditThresholdAdjustment } : undefined,
    }

    const delegationDecision = assessDelegationDecision(delegationInput)

    // Record pre-pipeline trajectory for bandit learning
    if (banditTuner && banditArmId) {
      banditTrajectory = banditTuner.buildTrajectory({
        armId: banditArmId,
        appliedThreshold: 0.2 + banditThresholdAdjustment,
        complexityScore: decision.score,
        fanoutCount: subagentProfiles.length,
        stepCount: plan.steps.length,
        nestingDepth: 1,
        parallelFraction: subagentProfiles.filter(s => s.canRunParallel).length / Math.max(1, subagentProfiles.length),
        shouldDelegate: delegationDecision.shouldDelegate,
        utilityScore: delegationDecision.utilityScore,
      })
    }

    ctx.onTrace?.({
      kind: "planner-delegation-decision",
      shouldDelegate: delegationDecision.shouldDelegate,
      reason: delegationDecision.reason,
      utilityScore: delegationDecision.utilityScore,
      safetyRisk: delegationDecision.safetyRisk,
      confidence: delegationDecision.confidence,
      hardBlockedTaskClass: delegationDecision.hardBlockedTaskClass,
      banditArmId,
      banditThresholdAdjustment,
    })

    if (!delegationDecision.shouldDelegate) {
      const reason = `Delegation blocked: ${delegationDecision.reason} (utility=${delegationDecision.utilityScore.toFixed(2)}, safety=${delegationDecision.safetyRisk.toFixed(2)})`
      return {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "delegation",
          reason,
          diagnostics: [{
            utilityScore: delegationDecision.utilityScore,
            safetyRisk: delegationDecision.safetyRisk,
            reason: delegationDecision.reason,
          }],
          score: decision.score,
          plannerReason: decision.reason,
        }),
        plan,
        skipReason: reason,
      }
    }
  }

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs contract validation + deterministic probes each round.
  // Retry decisions are made by the escalation graph.
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  const compatibilityMode = resolvePlannerCompatibilityMode()
  const compatibilityThreshold = resolvePlannerCompatibilityThreshold()
  let legacyPinnedForRun = compatibilityMode === "legacy"
  let retryOpts: {
    priorResults?: Map<string, import("./types.js").PipelineStepResult>
    repairPlan?: RepairPlan
  } = {}
  let verifierRounds = 0
  // Track issues per step across attempts to detect repeated identical failures
  const priorStepIssues = new Map<string, string>()
  // Track stub-issue count per step across attempts — if count doesn't decrease,
  // the child is stuck and further retries won't help
  const priorStubCounts = new Map<string, number>()
  // Repeated fatal failures should bypass additional retries and force replan.
  let forceReplanForFatalPattern = false

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
        repairPlan: retryOpts.repairPlan,
        runtimeModel,
        signal: ctx.signal,
        onStepStart: (step) => ctx.onTrace?.({
          kind: "planner-step-start",
          stepName: step.name,
          stepType: step.stepType,
        }),
        onStepEnd: (step, result) => {
          ctx.onTrace?.({
            kind: "planner-step-end",
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
            kind: "planner-step-transition",
            attempt: attempt + 1,
            stepName: step.name,
            phase: "execution",
            state: result.acceptanceState ?? result.status,
            timestamp: Date.now(),
          })
        },
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
    const computedRepairPlan = buildRepairPlan(plan, pipelineResult, verifierDecision)
    verifierDecision = {
      ...verifierDecision,
      repairPlan: computedRepairPlan,
    }
    const legacyRetryPlan = buildLegacyRetryPlan(plan, pipelineResult, verifierDecision)
    const repairCompatibility = compareRepairPlanCompatibility(
      compatibilityMode,
      legacyRetryPlan,
      computedRepairPlan,
    )
    if (
      compatibilityMode === "shadow"
      && repairCompatibility.diverged
      && repairCompatibility.divergenceScore >= compatibilityThreshold
    ) {
      legacyPinnedForRun = true
    }
    const activeCompatibilityPath: "legacy" | "repair" = compatibilityMode === "repair"
      ? "repair"
      : legacyPinnedForRun
        ? "legacy"
        : "repair"
    pipelineResult = applyVerificationAcceptanceStates(pipelineResult, verifierDecision)

    ctx.onTrace?.({
      kind: "planner-verification",
      overall: verifierDecision.overall,
      confidence: verifierDecision.confidence,
      verifierRound: verifierRounds + 1,
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
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: verifierDecision.overall === "pass" ? "preserved" : "repairing_in_place",
        reason: verifierDecision.overall === "pass" ? "verification_passed" : "architecture_preserving_repair",
        architecture: plan.coherentBootstrap.architecture,
      })
    }
    ctx.onTrace?.({
      kind: "planner-issue-timeline",
      attempt: attempt + 1,
      verifierRound: verifierRounds + 1,
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
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: step.stepName,
        phase: "verification",
        state: pipelineResult?.stepResults.get(step.stepName)?.acceptanceState ?? step.outcome,
        timestamp: Date.now(),
      })
    }
    ctx.onTrace?.({
      kind: "planner-repair-plan",
      attempt: attempt + 1,
      epoch: attempt + 1,
      rerunOrder: verifierDecision.repairPlan?.rerunOrder ?? [],
      tasks: verifierDecision.repairPlan?.tasks.map(task => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map(issue => issue.code),
        dependencyIssueCodes: task.dependencyContext.map(issue => issue.code),
      })) ?? [],
    })
    ctx.onTrace?.({
      kind: "planner-repair-compatibility",
      attempt: attempt + 1,
      mode: repairCompatibility.mode,
      activePath: activeCompatibilityPath,
      diverged: repairCompatibility.diverged,
      divergenceScore: repairCompatibility.divergenceScore,
      divergenceThreshold: compatibilityThreshold,
      pinnedToLegacy: compatibilityMode === "shadow" && legacyPinnedForRun,
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
      const issueKey = buildIssueIdentity(stepAssessment)
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

    if (plan.coherentBootstrap && escalation.action === "escalate") {
      ctx.onTrace?.({
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: "abandoned",
        reason: escalation.reason,
        architecture: plan.coherentBootstrap.architecture,
      })
    }

    if (escalation.action === "pass" || escalation.action === "escalate") {
      break
    }

    // Build targeted retry context from verifier feedback
    const priorResults = new Map<string, import("./types.js").PipelineStepResult>()
    const NON_RETRYABLE_CLASSES = new Set(["cancelled", "spawn_error"])
    const currentRepairPlan = verifierDecision.repairPlan ?? buildRepairPlan(plan, pipelineResult, verifierDecision)
    const activeRepairPlan = activeCompatibilityPath === "legacy"
      ? {
        tasks: legacyRetryPlan.tasks,
        rerunOrder: legacyRetryPlan.rerunOrder,
        skippedVerifiedSteps: legacyRetryPlan.skippedVerifiedSteps,
      }
      : currentRepairPlan

    // Detect repeated identical failures — if a step produces the same issues
    // as the previous attempt, further retries won't help (LLM is stuck).
    let allStepsRepeatedFailure = true
    let shouldAbortRetriesForFatalPattern = false

    // ── Stub-count regression tracking ──
    // Track the number of stub-related issues per step across retries.
    // If a retry doesn't reduce the stub count, the child is stuck — abort.
    const STUB_KEYWORDS = ["stub", "placeholder", "empty array", "empty object", "returns constant", "catch-all", "trivial return", "empty function"]

    for (const stepAssessment of verifierDecision.steps) {
      const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)

      // Check if this step's issues are identical to the previous attempt
      const issueKey = buildIssueIdentity(stepAssessment)
      const prevIssueKey = priorStepIssues.get(stepAssessment.stepName)

      // Count stub-specific issues for regression tracking
      const currentStubCount = stepAssessment.issues.filter(i =>
        STUB_KEYWORDS.some(kw => i.toLowerCase().includes(kw)),
      ).length
      const prevStubCount = priorStubCounts.get(stepAssessment.stepName)
      const hasFatalPattern = stepAssessment.issues.some(i =>
        /function loss|\[contract:contradictory_completion_claim\]|\[contract:unresolved_handoff_output\]/i.test(i),
      )

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
          allStepsRepeatedFailure = false
        }

        if (hasFatalPattern && isExactRepeat) {
          shouldAbortRetriesForFatalPattern = true
          forceReplanForFatalPattern = true
          ctx.onTrace?.({
            kind: "planner-retry-abort",
            stepName: stepAssessment.stepName,
            reason: "Repeated fatal pattern detected (FUNCTION LOSS / contradictory completion claim) — aborting retries and forcing replan",
          })
        }

        priorStepIssues.set(stepAssessment.stepName, issueKey)
        priorStubCounts.set(stepAssessment.stepName, currentStubCount)
      } else {
        allStepsRepeatedFailure = false
      }
    }

    // If every failing step has repeated identical issues, stop retrying entirely
    const retryableTaskCount = activeRepairPlan.tasks.filter((task) => task.mode !== "blocked").length
    if (allStepsRepeatedFailure && retryableTaskCount === 0) {
      ctx.onTrace?.({
        kind: "planner-retry-abort",
        reason: "All failing steps have repeated identical issues — aborting retries",
      })
      break
    }

    if (shouldAbortRetriesForFatalPattern) {
      break
    }

    ctx.onTrace?.({
      kind: "planner-retry",
      attempt: attempt + 1,
      reason: verifierDecision.unresolvedItems.join("; "),
      skippedSteps: priorResults.size,
      retrySteps: retryableTaskCount,
      rerunOrder: activeRepairPlan.rerunOrder,
    })
    for (const task of activeRepairPlan.tasks) {
      ctx.onTrace?.({
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: task.stepName,
        phase: "repair",
        state: task.mode,
        timestamp: Date.now(),
      })
    }

    // Store retry context for next iteration
    retryOpts = { priorResults, repairPlan: activeRepairPlan }
  }

  // Step 6: Synthesize final answer
  if (forceReplanForFatalPattern) {
    ctx.onTrace?.({
      kind: "planner-escalation",
      action: "escalate",
      reason: "Forced replan after repeated fatal FUNCTION LOSS / contradictory completion pattern",
    })
  }

  const answer = synthesizeAnswer(plan, pipelineResult!, verifierDecision!)

  // Record bandit outcome now that we have a verifier decision and final pipeline state
  if (banditTuner && banditTrajectory) {
    const failedSteps = [...pipelineResult!.stepResults.values()].filter(r => r.status === "failed").length
    const verifierPassed = verifierDecision!.overall === "pass"
    const qualityProxy = verifierPassed ? verifierDecision!.confidence : (verifierDecision!.overall === "partial" ? 0.4 : 0.1)
    banditTuner.recordOutcome(banditTrajectory, {
      durationMs: Date.now() - pipelineStartMs,
      tokenCount: 0,  // not available at this layer
      errorCount: failedSteps,
      qualityProxy,
      verifierPassed,
    })
  }

  // Contract-governed-first behavior: if verification didn't pass after all
  // retries, DO NOT fall through to the unstructured direct tool loop.
  // Return a structured failure response and keep remediation in planner mode.
  if (verifierDecision!.overall !== "pass") {
    return {
      handled: true,
      answer,
      plan,
      pipelineResult,
      verifierDecision,
      skipReason: "Verification failed after retries — structured execution halted",
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
