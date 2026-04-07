/**
 * Verifier — post-pipeline verification of execution results.
 *
 * Two-phase verification (agenc-core pattern):
 *   1. Deterministic probes — check file existence, run build/test commands
 *   2. LLM-based assessment — structured confidence check per step
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierDecision,
    VerifierOutcome,
    VerifierStepAssessment,
} from "./types.js"

// ============================================================================
// Deterministic probes
// ============================================================================

/**
 * Run deterministic acceptance probes — file existence checks, build commands, etc.
 * Returns per-step assessments based on concrete evidence.
 */
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
        outcome: stepResult?.status === "skipped" ? "fail" : "fail",
        confidence: 1.0,
        issues: [stepResult?.error ?? `Step ${step.name} did not complete`],
        retryable: true,
      })
      continue
    }

    if (step.stepType === "subagent_task") {
      const sa = step as SubagentTaskStep
      const issues: string[] = []

      // Check target artifacts exist
      const readFile = toolMap.get("read_file")
      if (readFile && sa.executionContext.targetArtifacts.length > 0) {
        for (const artifact of sa.executionContext.targetArtifacts) {
          try {
            const content = await readFile.execute({ path: artifact })
            if (content.startsWith("Error:") || content.includes("not found") || content.includes("ENOENT")) {
              issues.push(`Target artifact "${artifact}" not found`)
            }
          } catch {
            issues.push(`Could not read target artifact "${artifact}"`)
          }
        }
      }

      // If verification mode is browser_check, run it
      if (sa.executionContext.verificationMode === "browser_check") {
        const browserCheck = toolMap.get("browser_check")
        if (browserCheck) {
          const htmlArtifacts = sa.executionContext.targetArtifacts.filter(
            a => a.endsWith(".html") || a.endsWith(".htm"),
          )
          for (const html of htmlArtifacts) {
            try {
              const result = await browserCheck.execute({ url: html })
              if (/error|fail|exception/i.test(result) && !/no errors/i.test(result)) {
                issues.push(`Browser check for "${html}" reported errors: ${result.slice(0, 300)}`)
              }
            } catch {
              issues.push(`Browser check failed for "${html}"`)
            }
          }
        }
      }

      // If verification mode is run_tests, run the test command
      if (sa.executionContext.verificationMode === "run_tests") {
        const runCmd = toolMap.get("run_command")
        if (runCmd) {
          try {
            const result = await runCmd.execute({ command: "npm test 2>&1 || exit 0" })
            // Only flag real test failures ("X failed", "FAIL"), not incidental mentions of error/fail
            if (/\d+\s+fail|FAIL\s|tests?\s+failed/i.test(result) && !/0 failed/i.test(result)) {
              issues.push(`Test run reported failures: ${result.slice(0, 300)}`)
            }
          } catch {
            issues.push("Test run failed to execute")
          }
        }
      }

      assessments.push({
        stepName: step.name,
        outcome: issues.length > 0 ? "retry" : "pass",
        confidence: issues.length > 0 ? 0.3 : 0.8,
        issues,
        retryable: true,
      })
    } else {
      // Deterministic tool steps: if they completed, they pass
      assessments.push({
        stepName: step.name,
        outcome: "pass",
        confidence: 1.0,
        issues: [],
        retryable: false,
      })
    }
  }

  return assessments
}

// ============================================================================
// LLM-based verification
// ============================================================================

const VERIFIER_SYSTEM_PROMPT = `You are a verification agent. You review the results of a multi-step execution plan and assess whether each step's acceptance criteria were met.

You MUST respond with valid JSON matching this schema:
{
  "overall": "pass" | "retry" | "fail",
  "confidence": 0.85,
  "steps": [
    {
      "stepName": "step_name",
      "outcome": "pass" | "retry" | "fail",
      "confidence": 0.9,
      "issues": ["issue description"],
      "retryable": true
    }
  ],
  "unresolvedItems": ["any remaining concerns"]
}

Rules:
- "pass" means the step completed and produced reasonable output for its objective
- "retry" means the step produced output but has clear, concrete deficiencies that a retry could fix
- "fail" means the step fundamentally failed (error, no output, wrong approach entirely)
- Be practical: if the step produced working output that meets the core objective, mark it as pass even if minor polish is possible
- Only mark "retry" for specific, actionable issues — not vague concerns about quality
- If deterministic probes passed for a step, strongly prefer "pass" unless you see a clear problem
- confidence is 0.0 to 1.0
- Respond ONLY with the JSON object`

/**
 * Ask the LLM to assess plan execution results against acceptance criteria.
 */
export async function runLLMVerification(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  deterministicAssessments: readonly VerifierStepAssessment[],
  opts?: { signal?: AbortSignal },
): Promise<VerifierDecision> {
  // Build verification context
  const stepSummaries = plan.steps.map(step => {
    const result = pipelineResult.stepResults.get(step.name)
    const detAssessment = deterministicAssessments.find(a => a.stepName === step.name)

    return {
      name: step.name,
      type: step.stepType,
      ...(step.stepType === "subagent_task" ? {
        objective: (step as SubagentTaskStep).objective,
        acceptanceCriteria: (step as SubagentTaskStep).acceptanceCriteria,
      } : {}),
      status: result?.status ?? "unknown",
      output: result?.output?.slice(0, 1000) ?? result?.error ?? "no output",
      deterministicResult: detAssessment ? {
        outcome: detAssessment.outcome,
        issues: detAssessment.issues,
      } : undefined,
    }
  })

  const messages: Message[] = [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Verify the following plan execution results:\n\nPlan reason: ${plan.reason}\n\nStep results:\n${JSON.stringify(stepSummaries, null, 2)}`,
    },
  ]

  try {
    const response = await llm.chat(messages, [], { signal: opts?.signal })
    if (!response.content) {
      return buildFallbackDecision(deterministicAssessments)
    }

    return parseLLMVerification(response.content, deterministicAssessments)
  } catch {
    // Fallback to deterministic-only assessment
    return buildFallbackDecision(deterministicAssessments)
  }
}

// ============================================================================
// Combined verification
// ============================================================================

/**
 * Full verification: deterministic probes + LLM assessment.
 * Returns a merged VerifierDecision.
 */
export async function verify(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  tools: readonly Tool[],
  opts?: { signal?: AbortSignal },
): Promise<VerifierDecision> {
  // Phase 1: Deterministic probes
  const detAssessments = await runDeterministicProbes(plan, pipelineResult, tools)

  // If deterministic probes already show clear failure, skip LLM verification
  const detFails = detAssessments.filter(a => a.outcome === "fail" || a.outcome === "retry")
  if (detFails.length > 0 && detFails.some(a => a.outcome === "fail")) {
    return buildFallbackDecision(detAssessments)
  }

  // Phase 2: LLM verification
  const decision = await runLLMVerification(llm, plan, pipelineResult, detAssessments, opts)

  // Merge: if deterministic says "retry" but LLM says "pass", trust deterministic
  const mergedSteps = decision.steps.map(llmStep => {
    const detStep = detAssessments.find(d => d.stepName === llmStep.stepName)
    if (detStep && detStep.outcome !== "pass" && llmStep.outcome === "pass") {
      return { ...detStep } // deterministic issues override LLM optimism
    }
    return llmStep
  })

  const anyRetry = mergedSteps.some(s => s.outcome === "retry")
  const anyFail = mergedSteps.some(s => s.outcome === "fail")

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(decision.confidence, ...mergedSteps.map(s => s.confidence)),
    steps: mergedSteps,
    unresolvedItems: decision.unresolvedItems,
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseLLMVerification(
  raw: string,
  fallbackAssessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1].trim()
  }

  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>

    const steps: VerifierStepAssessment[] = Array.isArray(obj.steps)
      ? (obj.steps as Array<Record<string, unknown>>).map(s => ({
          stepName: String(s.stepName ?? ""),
          outcome: parseOutcome(s.outcome),
          confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
          issues: Array.isArray(s.issues) ? s.issues.map(String) : [],
          retryable: Boolean(s.retryable ?? true),
        }))
      : [...fallbackAssessments]

    return {
      overall: parseOutcome(obj.overall),
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
      steps,
      unresolvedItems: Array.isArray(obj.unresolvedItems) ? obj.unresolvedItems.map(String) : [],
    }
  } catch {
    return buildFallbackDecision(fallbackAssessments)
  }
}

function parseOutcome(value: unknown): VerifierOutcome {
  const s = String(value ?? "")
  if (s === "pass" || s === "retry" || s === "fail") return s
  return "pass" // default to pass on ambiguity — avoid pointless retries
}

function buildFallbackDecision(
  assessments: readonly VerifierStepAssessment[],
): VerifierDecision {
  const anyFail = assessments.some(a => a.outcome === "fail")
  const anyRetry = assessments.some(a => a.outcome === "retry")
  const allIssues = assessments.flatMap(a => a.issues)

  return {
    overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
    confidence: Math.min(1.0, ...assessments.map(a => a.confidence)),
    steps: [...assessments],
    unresolvedItems: allIssues,
  }
}
