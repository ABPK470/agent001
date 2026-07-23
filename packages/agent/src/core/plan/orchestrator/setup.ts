/**
 * Planner setup phase: plan generation, validation, delegation gate.
 *
 * @module
 */

import { DiagnosticSeverity, PlannerTraceKind } from "../../../domain/index.js"
import { generatePlan } from "../generate/index.js"
import { injectBlueprintStep, strengthenExistingBlueprintSteps } from "../internal/index-blueprint.js"
import {
  applyWarningAutoFixes,
  inferForcedOutputDirectoryFromGoal,
  injectBrowserRuntimeContracts,
  injectHelperDependencyContracts,
  injectSharedStateOwnershipContract,
  injectVisualStyleContracts,
  injectWarningsIntoSteps,
  normalizePlanOutputDirectory,
  remediateValidationErrors
} from "../normalize/index.js"
import { compilePlannerRuntime } from "../runtime-model.js"
import type { PlannerDecision } from "../types.js"
import { validatePlan } from "../validate/index.js"
import { buildPlannerFailurePayload } from "./helpers.js"
import { runDelegationGate } from "./setup-delegation.js"
import type { PlannerContext, PlannerResult, PlannerSetupContext } from "./types.js"

export type SetupOutcome =
  | { readonly ready: false; readonly result: PlannerResult }
  | { readonly ready: true; readonly context: PlannerSetupContext }

export async function runPlannerSetup(
  goal: string,
  ctx: PlannerContext,
  decision: PlannerDecision
): Promise<SetupOutcome> {
  ctx.onTrace?.({
    kind: PlannerTraceKind.Decision,
    score: decision.score,
    shouldPlan: decision.shouldPlan,
    route: decision.route,
    reason: decision.reason
  })

  if (!decision.shouldPlan) {
    return {
      ready: false,
      result: {
        handled: false,
        skipReason: `route=${decision.route} (${decision.reason})`
      }
    }
  }

  ctx.onTrace?.({ kind: PlannerTraceKind.Generating })
  const genResult = await generatePlan(
    ctx.llm,
    {
      goal,
      availableTools: ctx.tools,
      workspaceRoot: ctx.workspaceRoot,
      history: ctx.history
    },
    {
      maxAttempts: 3,
      signal: ctx.signal
    }
  )

  if (!genResult.plan) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.GenerationFailed,
      diagnostics: genResult.diagnostics
    })
    const reason = `Plan generation failed: ${genResult.diagnostics.map((d) => d.message).join("; ")}`
    return {
      ready: false,
      result: {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "generation",
          reason,
          diagnostics: genResult.diagnostics,
          score: decision.score,
          plannerReason: decision.reason
        }),
        skipReason: reason
      }
    }
  }

  const plan = { ...genResult.plan, route: decision.route }

  const forcedOutputDir = inferForcedOutputDirectoryFromGoal(goal)
  if (forcedOutputDir) {
    normalizePlanOutputDirectory(plan, forcedOutputDir)
    ctx.onTrace?.({ kind: PlannerTraceKind.OutputRootForced, outputRoot: forcedOutputDir })
  }

  ctx.onTrace?.({
    kind: PlannerTraceKind.PlanGenerated,
    reason: plan.reason,
    stepCount: plan.steps.length,
    steps: plan.steps.map((s) => ({
      name: s.name,
      type: s.stepType,
      dependsOn: s.dependsOn ? [...s.dependsOn] : undefined
    })),
    edges: plan.edges.map((e) => ({ from: e.from, to: e.to }))
  })

  let validation = validatePlan(plan, ctx.tools)
  let errors = validation.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)
  let warnings = validation.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning)

  if (!validation.valid) {
    const remediated = remediateValidationErrors(plan, errors)
    if (remediated) {
      const after = validatePlan(plan, ctx.tools)
      if (after.valid) {
        validation = after
        errors = validation.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)
        warnings = validation.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning)
        ctx.onTrace?.({
          kind: PlannerTraceKind.ValidationRemediated,
          diagnostics: validation.diagnostics
        })
      }
    }
  }

  if (!validation.valid) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.ValidationFailed,
      diagnostics: errors
    })
    const reason = `Validation failed: ${errors.map((d) => d.message).join("; ")}`
    return {
      ready: false,
      result: {
        handled: true,
        answer: buildPlannerFailurePayload({
          stage: "validation",
          reason,
          diagnostics: errors,
          score: decision.score,
          plannerReason: decision.reason
        }),
        plan,
        skipReason: reason
      }
    }
  }

  normalizePlanOutputDirectory(plan, forcedOutputDir ?? undefined)

  if (warnings.length > 0) {
    applyWarningAutoFixes(plan, warnings)
    ctx.onTrace?.({
      kind: PlannerTraceKind.ValidationWarnings,
      warningCount: warnings.length,
      diagnostics: warnings
    })
    injectWarningsIntoSteps(plan, warnings)
  }

  injectSharedStateOwnershipContract(plan)
  injectBrowserRuntimeContracts(plan)
  injectHelperDependencyContracts(plan)
  injectVisualStyleContracts(plan)
  injectBlueprintStep(plan, ctx.workspaceRoot, forcedOutputDir)
  strengthenExistingBlueprintSteps(plan, ctx.workspaceRoot, forcedOutputDir)
  const runtimeModel = compilePlannerRuntime(plan)

  ctx.onTrace?.({
    kind: PlannerTraceKind.RuntimeCompiled,
    executionSteps: [...runtimeModel.executionGraph.values()].map((node) => ({
      stepName: node.stepName,
      dependsOn: [...node.dependsOn],
      downstream: [...node.downstream]
    })),
    ownershipArtifacts: [...runtimeModel.ownershipGraph.values()].map((node) => ({
      artifactPath: node.artifactPath,
      ownerStepName: node.ownerStepName,
      consumerStepNames: [...node.consumerStepNames]
    })),
    runtimeEntities: runtimeModel.runtimeEntities
  })

  const gate = runDelegationGate(plan, goal, decision, ctx)
  if (gate.blocked) return { ready: false, result: gate.result }
  const { mode: executionMode } = gate

  return {
    ready: true,
    context: {
      plan,
      runtimeModel,
      decision,
      banditTrajectory: undefined,
      executionMode
    }
  }
}
