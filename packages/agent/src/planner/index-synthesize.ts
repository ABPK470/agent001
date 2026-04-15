/**
 * Answer synthesis — build a human-readable summary from planner results.
 * @module
 */

import type { PipelineResult, Plan, VerifierDecision } from "./types.js"

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
    const acceptanceState = result?.acceptanceState
    const effectiveAcceptance = acceptanceState
      ?? (stepVerification?.outcome === "pass"
        ? "accepted"
        : stepVerification?.outcome === "retry" || stepVerification?.outcome === "fail"
          ? "repair_required"
          : undefined)
    const status = effectiveAcceptance === "accepted"
      ? "verified"
      : effectiveAcceptance === "repair_required"
        ? "incomplete"
        : effectiveAcceptance === "rejected"
          ? "rejected"
          : (result?.status ?? "unknown")
    const icon = effectiveAcceptance === "accepted"
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
