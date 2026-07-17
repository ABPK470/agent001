import { VerifierOutcome } from "../../domain/index.js"
/**
 * Answer synthesis — build a human-readable summary from planner results.
 * @module
 */

import { synthesizePlatformUnconfiguredAnswer } from "./platform-errors.js"
import type { PipelineResult, Plan, VerifierDecision } from "./types.js"

function normalizeSuccessfulOutput(text: string): string {
  return text
    .trim()
    .replace(/^done:\s*/i, "")
    .replace(/^completed:\s*/i, "")
}

function synthesizeSuccessfulAnswer(plan: Plan, pipelineResult: PipelineResult): string {
  const outputs = plan.steps
    .map((step) => pipelineResult.stepResults.get(step.name)?.output)
    .filter((output): output is string => typeof output === "string" && output.trim().length > 0)
    .map(normalizeSuccessfulOutput)

  const uniqueOutputs = [...new Set(outputs)]
  if (uniqueOutputs.length > 0) {
    return uniqueOutputs.join("\n\n")
  }

  const producedArtifacts = plan.steps.flatMap(
    (step) => pipelineResult.stepResults.get(step.name)?.producedArtifacts ?? []
  )
  const uniqueArtifacts = [...new Set(producedArtifacts)]
  if (uniqueArtifacts.length === 1) {
    return `Created ${uniqueArtifacts[0]}.`
  }
  if (uniqueArtifacts.length > 1) {
    return `Created ${uniqueArtifacts.length} files: ${uniqueArtifacts.join(", ")}.`
  }

  return pipelineResult.completedSteps === pipelineResult.totalSteps
    ? "Completed successfully."
    : `Completed ${pipelineResult.completedSteps} of ${pipelineResult.totalSteps} steps.`
}

export function synthesizeAnswer(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision
): string {
  // Platform-unconfigured short-circuit — if any step failed because a required
  // platform integration is missing, the verbose "Task verification FAILED" wall
  // is misleading and leaks operator-only details to the end user. Emit an
  // opaque, user-safe message instead. The technical detail (env var to set,
  // missing service name) is logged server-side by run-executor; the user
  // gets a run reference they can forward to the platform admin.
  const hasPlatformUnconfigured = [...pipelineResult.stepResults.values()].some(
    (r) => r.failureClass === "platform_unconfigured"
  )
  if (hasPlatformUnconfigured) {
    return synthesizePlatformUnconfiguredAnswer()
  }

  if (verifierDecision.overall === VerifierOutcome.Pass) {
    return synthesizeSuccessfulAnswer(plan, pipelineResult)
  }

  const parts: string[] = []

  if (verifierDecision.overall === VerifierOutcome.Retry) {
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
    const stepVerification = verifierDecision.steps.find((s) => s.stepName === step.name)
    const acceptanceState = result?.acceptanceState
    const effectiveAcceptance =
      acceptanceState ??
      (stepVerification?.outcome === VerifierOutcome.Pass
        ? "accepted"
        : stepVerification?.outcome === VerifierOutcome.Retry ||
            stepVerification?.outcome === VerifierOutcome.Fail
          ? "repair_required"
          : undefined)
    const status =
      effectiveAcceptance === "accepted"
        ? "verified"
        : effectiveAcceptance === "repair_required"
          ? "incomplete"
          : effectiveAcceptance === "rejected"
            ? "rejected"
            : (result?.status ?? "unknown")
    const icon =
      effectiveAcceptance === "accepted"
        ? "✓"
        : effectiveAcceptance === "repair_required"
          ? "⚠"
          : status === "failed" || effectiveAcceptance === "rejected"
            ? "✗"
            : "⊘"
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

  if (verifierDecision.repairPlan && verifierDecision.repairPlan.tasks.length > 0) {
    parts.push("")
    parts.push("Repair Plan:")
    for (const task of verifierDecision.repairPlan.tasks) {
      parts.push(`  - ${task.stepName}: ${task.mode}`)
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
