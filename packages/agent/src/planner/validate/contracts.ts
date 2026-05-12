/**
 * Step contract, artifact ownership, and verification coverage passes.
 * Extracted from validate.ts.
 *
 * @module
 */

import type { PlanDiagnostic, PlanStep, SubagentTaskStep } from "../types.js"

export function validateStepContracts(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  for (const step of steps) {
    if (step.stepType === "subagent_task") {
      const sa = step as SubagentTaskStep

      if (!sa.objective || sa.objective.trim().length < 10) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "vague_objective",
          message: `Subagent step "${step.name}" has a vague or missing objective. Provide a specific, measurable objective (min 10 chars).`,
          stepName: step.name,
        })
      }

      if (sa.acceptanceCriteria.length === 0) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "missing_acceptance_criteria",
          message: `Subagent step "${step.name}" has no acceptance criteria. Add at least one measurable success condition.`,
          stepName: step.name,
        })
      }

      for (const crit of sa.acceptanceCriteria) {
        if (crit.length < 10 || /^(done|works?|good|complete|ok)$/i.test(crit.trim())) {
          diagnostics.push({
            category: "contract",
            severity: "warning",
            code: "vague_criteria",
            message: `Subagent step "${step.name}" has vague acceptance criterion: "${crit}". Be specific and measurable.`,
            stepName: step.name,
          })
        }
      }

      if (sa.requiredToolCapabilities.length === 0) {
        diagnostics.push({
          category: "contract",
          severity: "warning",
          code: "no_tool_capabilities",
          message: `Subagent step "${step.name}" declares no required tool capabilities. Specify which tools the child needs.`,
          stepName: step.name,
        })
      }
    }
  }

  return diagnostics
}

export function validateArtifactOwnership(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const writeOwners = new Map<string, string[]>()

  for (const step of steps) {
    if (step.stepType !== "subagent_task") continue
    const sa = step as SubagentTaskStep
    const relations = [
      ...(sa.executionContext?.artifactRelations ?? []),
      ...(sa.workflowStep?.artifactRelations ?? []),
    ]
    for (const rel of relations) {
      if (rel.relationType === "write_owner") {
        const owners = writeOwners.get(rel.artifactPath) ?? []
        if (!owners.includes(step.name)) {
          owners.push(step.name)
        }
        writeOwners.set(rel.artifactPath, owners)
      }
    }
  }

  for (const [artifact, owners] of writeOwners) {
    if (owners.length > 1) {
      diagnostics.push({
        category: "ownership",
        severity: "error",
        code: "multiple_write_owners",
        message: `Artifact "${artifact}" has ${owners.length} write owners: [${owners.join(", ")}]. Only ONE step may be write_owner for a given artifact.`,
      })
    }
  }

  return diagnostics
}

export function validateVerificationCoverage(steps: readonly PlanStep[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = []

  const subagentSteps = steps.filter(s => s.stepType === "subagent_task") as SubagentTaskStep[]

  const hasWriters = subagentSteps.some(
    s => s.executionContext?.effectClass !== "readonly",
  )
  const hasVerification = subagentSteps.some(
    s => s.executionContext?.verificationMode !== "none",
  )

  if (hasWriters && !hasVerification && subagentSteps.length > 1) {
    diagnostics.push({
      category: "verification",
      severity: "warning",
      code: "no_verification_steps",
      message: "Plan has write steps but no per-step verification mode. This is allowed; final verifier checks run after implementation. Consider setting verificationMode only on steps that fully own runnable artifacts.",
    })
  }

  return diagnostics
}
