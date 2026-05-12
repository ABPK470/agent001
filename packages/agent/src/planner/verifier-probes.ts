/**
 * Verifier deterministic probes — top-level loop that fans out per-step
 * assessment and runs cross-step integration probes.
 *
 * Per-subagent assessment lives in verifier-probes/subagent-assessment.ts.
 *
 * @module
 */

import type { Tool } from "../types.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierStepAssessment,
} from "./types.js"
import { runIntegrationProbes } from "./verifier-integration.js"
import { assessSubagentStep } from "./verifier-probes/subagent-assessment.js"

export async function runDeterministicProbes(
  plan: Plan,
  pipelineResult: PipelineResult,
  tools: readonly Tool[],
): Promise<VerifierStepAssessment[]> {
  const assessments: VerifierStepAssessment[] = []
  const toolMap = new Map(tools.map(t => [t.name, t]))

  for (const step of plan.steps) {
    const stepResult = pipelineResult.stepResults.get(step.name)
    if (!stepResult || stepResult.status !== "completed") {
      assessments.push({
        stepName: step.name,
        outcome: "fail",
        confidence: 1.0,
        issues: [stepResult?.error ?? `Step ${step.name} did not complete`],
        retryable: true,
      })
      continue
    }

    if (step.stepType === "subagent_task") {
      assessments.push(await assessSubagentStep(step as SubagentTaskStep, stepResult, plan, pipelineResult, toolMap))
    } else {
      assessments.push({
        stepName: step.name,
        outcome: "pass",
        confidence: 1.0,
        issues: [],
        retryable: false,
      })
    }
  }

  // Cross-step integration probe
  const allSubagentStepsCompleted = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .every((s) => pipelineResult.stepResults.get(s.name)?.status === "completed")

  if (allSubagentStepsCompleted) {
    await runIntegrationProbes(plan, pipelineResult, toolMap, assessments)
  }

  return assessments
}
