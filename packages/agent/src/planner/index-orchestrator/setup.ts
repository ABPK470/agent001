/**
 * Planner setup phase (Steps 1–3b): routing decision, plan generation,
 * validation, and delegation gate.  Returns either an early-exit PlannerResult
 * or a fully-resolved PlannerSetupContext ready for the execution loop.
 * @module
 */

import { assessPlannerDecision } from "../decision.js"
import { generateCoherentBootstrap, generatePlan } from "../generate.js"
import { injectBlueprintStep, strengthenExistingBlueprintSteps } from "../index-blueprint.js"
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
} from "../index-normalize.js"
import { compilePlannerRuntime } from "../runtime-model.js"
import type { PlannerCoherentBootstrap } from "../types.js"
import { validatePlan } from "../validate.js"
import { buildPlannerFailurePayload, resolvePlannerCompatibilityMode, resolvePlannerCompatibilityThreshold } from "./helpers.js"
import { runDelegationGate } from "./setup-delegation.js"
import type { PlannerContext, PlannerResult, PlannerSetupContext } from "./types.js"

/** Discriminated union returned by runPlannerSetup. */
export type SetupOutcome =
  | { readonly ready: false; readonly result: PlannerResult }
  | { readonly ready: true; readonly context: PlannerSetupContext }

/**
 * Execute planner setup (Steps 1–3b).
 *
 * Performs routing assessment, plan generation, plan validation, and the
 * delegation decision gate.  Returns either an early-exit PlannerResult (if
 * the task should not proceed) or a PlannerSetupContext for the execution loop.
 */
export async function runPlannerSetup(
  goal: string,
  ctx: PlannerContext,
  options?: { forceRoute?: "full_planner_decomposition" | "planner_with_coherent_bootstrap" },
): Promise<SetupOutcome> {
  const banditTuner = ctx.delegationBanditTuner

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
    return { ready: false, result: { handled: false, skipReason: `route=${decision.route} score=${decision.score} (${decision.reason})` } }
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
        ready: false,
        result: {
          handled: true,
          answer: buildPlannerFailurePayload({
            stage: "generation",
            reason,
            diagnostics: bootstrapResult.diagnostics,
            score: decision.score,
            plannerReason: decision.reason,
          }),
          skipReason: reason,
        },
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
      ready: false,
      result: {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "generation",
          reason,
          diagnostics: genResult.diagnostics,
          score: decision.score,
          plannerReason: decision.reason,
        }),
        skipReason: reason,
      },
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
      ready: false,
      result: {
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
      },
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
  const gate = runDelegationGate(plan, goal, decision, ctx, banditTuner)
  if (gate.blocked) return { ready: false, result: gate.result }
  const banditTrajectory = gate.banditTrajectory

  const compatibilityMode = resolvePlannerCompatibilityMode()
  const compatibilityThreshold = resolvePlannerCompatibilityThreshold()

  return {
    ready: true,
    context: {
      plan,
      runtimeModel,
      decision,
      banditTrajectory,
      compatibilityMode,
      compatibilityThreshold,
    },
  }
}
