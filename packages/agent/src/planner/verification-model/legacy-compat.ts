/**
 * Legacy retry plan + repair-plan compatibility comparison.
 *
 * Extracted from verification-model.ts to keep the main module focused
 * on evidence collection and repair-plan construction.
 *
 * @module
 */

import type {
    LegacyRetryPlan,
    PipelineResult,
    Plan,
    PlannerRepairCompatibilityMode,
    RepairPlan,
    RepairPlanCompatibilityReport,
    RepairTask,
    VerifierDecision,
} from "../types.js"
import {
    getArchitectureRepairContext,
    uniqueStrings,
} from "../internal/verification-inference.js"

export function buildLegacyRetryPlan(
  plan: Plan,
  pipelineResult: PipelineResult,
  decision: VerifierDecision,
): LegacyRetryPlan {
  const nonRetryableFailureClasses = new Set(["cancelled", "spawn_error"])
  const architectureContext = getArchitectureRepairContext(plan)
  const tasks: RepairTask[] = []

  for (const assessment of decision.steps) {
    if (assessment.outcome === "pass") continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const isBlocked = assessment.retryable === false
      || (stepResult?.failureClass != null && nonRetryableFailureClasses.has(stepResult.failureClass))
      || stepResult?.acceptanceState === "blocked"

    tasks.push({
      stepName: assessment.stepName,
      mode: isBlocked ? "blocked" : "repair",
      ownedIssues: [...(assessment.issueDetails ?? [])],
      dependencyContext: [],
      requiredAcceptedArtifacts: [],
      preserveArchitecture: architectureContext?.preserveArchitecture,
      architectureSummary: architectureContext?.architectureSummary,
      sharedContracts: architectureContext?.sharedContracts,
      invariants: architectureContext?.invariants,
    })
  }

  const rerunOrder = plan.steps
    .map((step) => step.name)
    .filter((name) => tasks.some((task) => task.stepName === name && task.mode !== "blocked"))

  return {
    tasks,
    rerunOrder,
    skippedVerifiedSteps: decision.steps.filter((step) => step.outcome === "pass").map((step) => step.stepName),
  }
}

function taskCodes(task: RepairTask): string[] {
  return uniqueStrings(task.ownedIssues.map((issue) => issue.code)).sort()
}

export function compareRepairPlanCompatibility(
  mode: PlannerRepairCompatibilityMode,
  legacyPlan: LegacyRetryPlan,
  repairPlan: RepairPlan,
): RepairPlanCompatibilityReport {
  const reasons: string[] = []
  const activePath = mode === "legacy" ? "legacy" : "repair"

  const legacyTasks = new Map(legacyPlan.tasks.map((task) => [task.stepName, task]))
  const repairTasks = new Map(repairPlan.tasks.map((task) => [task.stepName, task]))

  const legacyRerun = new Set(legacyPlan.rerunOrder)
  const repairRerun = new Set(repairPlan.rerunOrder)
  const legacyOnly = [...legacyRerun].filter((stepName) => !repairRerun.has(stepName))
  const repairOnly = [...repairRerun].filter((stepName) => !legacyRerun.has(stepName))

  if (legacyOnly.length > 0) {
    reasons.push(`Legacy retry would rerun ${legacyOnly.join(", ")} but repair-plan scheduling would skip them.`)
  }
  if (repairOnly.length > 0) {
    reasons.push(`Repair-plan scheduling adds ${repairOnly.join(", ")} beyond the direct failing-step legacy retry set.`)
  }
  if (legacyPlan.rerunOrder.join("|") !== repairPlan.rerunOrder.join("|")) {
    reasons.push(`Rerun order diverged: legacy=${legacyPlan.rerunOrder.join(" -> ") || "none"}; repair=${repairPlan.rerunOrder.join(" -> ") || "none"}.`)
  }

  for (const stepName of [...new Set([...legacyTasks.keys(), ...repairTasks.keys()])]) {
    const legacyTask = legacyTasks.get(stepName)
    const repairTask = repairTasks.get(stepName)
    if (!legacyTask || !repairTask) continue

    if (legacyTask.mode !== repairTask.mode) {
      reasons.push(`Step ${stepName} mode diverged: legacy=${legacyTask.mode}, repair=${repairTask.mode}.`)
    }
    if (taskCodes(legacyTask).join("|") !== taskCodes(repairTask).join("|")) {
      reasons.push(`Step ${stepName} issue ownership diverged between legacy retry targeting and repair-plan targeting.`)
    }
    if (legacyTask.requiredAcceptedArtifacts.length !== repairTask.requiredAcceptedArtifacts.length) {
      reasons.push(`Step ${stepName} gained acceptance gates in repair-plan scheduling (${repairTask.requiredAcceptedArtifacts.length}) that legacy retry did not enforce.`)
    }
    if (legacyTask.dependencyContext.length !== repairTask.dependencyContext.length) {
      reasons.push(`Step ${stepName} gained dependency context in repair-plan scheduling (${repairTask.dependencyContext.length} issue(s)).`)
    }
  }

  return {
    mode,
    activePath,
    diverged: reasons.length > 0,
    divergenceScore: reasons.length,
    reasons,
    legacyPlan,
    repairPlan,
  }
}
