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
// Constants (ported from agenc-core chat-executor-verifier.ts)
// ============================================================================

/** Min verifier confidence for accepting subagent outputs. */
const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
/** Max chars retained from one subagent output in verifier prompts. */
// const MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS = 3_000

/** Evidence density indicators — output that contains these is more trustworthy. */
const EVIDENCE_DENSITY_RE = /(line|file|log|trace|stderr|stdout|stack|error|\d)/i
/** Hallucination risk: phrases suggesting the model is referencing artifacts without evidence. */
const HALLUCINATION_CLAIM_RE = /(according to|as seen in|from the logs|based on)/i
/** Source-like file paths that indicate real implementation work. */
const SOURCE_LIKE_PATH_RE =
  /(?:^|\/)(?:src|lib|app|server|client|cmd|pkg|include|internal|tests?|spec)(?:\/|$)|\.(?:c|cc|cpp|cxx|h|hpp|rs|go|py|rb|php|java|kt|swift|cs|js|jsx|ts|tsx|json|toml|yaml|yml|xml|sh|zsh|bash)$/i
/** Shell mutation pattern — commands that indicate workspace modifications. */
// const SHELL_MUTATION_RE =
//   /(?:^|[;&|]\s*|\n)\s*(?:cp|mv|rm|mkdir|touch|tee|sed|perl|python|node|ruby|go|cargo|npm|pnpm|yarn|make|cmake)\b|>>?/i
/** Direct mutation tool names. */
// const DIRECT_MUTATION_TOOLS = new Set(["write_file", "delete"])

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

      // ── Evidence density scoring (agenc-core pattern) ──
      const outputText = (stepResult.output ?? "").trim()
      const outputLower = outputText.toLowerCase()

      if (outputText.length > 0 && !EVIDENCE_DENSITY_RE.test(outputLower)) {
        issues.push("Weak evidence density: output lacks concrete indicators (file paths, line numbers, errors, data)")
      }

      // ── Hallucination detection (agenc-core pattern) ──
      if (
        outputText.length > 0 &&
        HALLUCINATION_CLAIM_RE.test(outputLower) &&
        !outputIntersectsArtifacts(outputLower, sa.executionContext.targetArtifacts)
      ) {
        issues.push("Hallucination risk: output references artifacts/logs but claims don't match known targets")
      }

      // ── Tool-call consistency check (agenc-core pattern) ──
      // If the step required tool capabilities but the child reported no tool usage,
      // it likely hallucinated or skipped actual execution.
      if (stepResult.output) {
        const parsedOutput = safeParseJson(stepResult.output)
        if (parsedOutput) {
          const toolCallCount = typeof parsedOutput.toolCalls === "number"
            ? parsedOutput.toolCalls
            : Array.isArray(parsedOutput.toolCalls) ? parsedOutput.toolCalls.length : -1
          const failedToolCallCount = typeof parsedOutput.failedToolCalls === "number"
            ? parsedOutput.failedToolCalls : 0

          if (toolCallCount === 0 && sa.executionContext.targetArtifacts.length > 0) {
            issues.push("Missing tool evidence: step required tool capabilities but reported zero tool calls")
          }
          if (toolCallCount > 0 && failedToolCallCount >= toolCallCount) {
            issues.push("All tool calls failed: child agent reported no successful tool executions")
          }
          if (parsedOutput.success === false || String(parsedOutput.status).toLowerCase() === "failed") {
            issues.push("Child agent reported explicit failure")
          }
        }
      }

      // ── Role-specific validation (agenc-core pattern) ──
      const role = sa.executionContext.role ?? "writer"
      if (role === "writer") {
        // Writer steps must produce mutations — not just findings
        const hasMutationEvidence = sa.executionContext.targetArtifacts.some(a => SOURCE_LIKE_PATH_RE.test(a))
        if (!hasMutationEvidence && outputText.length > 0 && !outputText.includes("write_file") && !outputText.includes("wrote")) {
          // Don't hard-fail, but note the concern
          if (!issues.some(i => i.includes("mutation"))) {
            issues.push("Writer step may lack mutation evidence — verify files were actually created/modified")
          }
        }
      }

      // ── Confidence from issue count (agenc-core formula) ──
      const confidence = Math.max(0, 1 - Math.min(0.9, issues.length * 0.18))
      const outcome: VerifierOutcome = issues.length > 0
        ? (confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE ? "fail" : "retry")
        : "pass"

      assessments.push({
        stepName: step.name,
        outcome,
        confidence,
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

const VERIFIER_SYSTEM_PROMPT = `You are a strict verifier for delegated outputs and implementation runs.

Grade steps by role:
- Reviewer steps: pass when they produce grounded findings backed by reads/workspace inspection. Do NOT require file mutation from reviewers.
- Writer steps: pass ONLY when they mutate owned target artifacts or explicitly report a grounded no-op with current target-artifact evidence. Findings alone are insufficient for writers.
- Validator steps: must enforce implementation completion and reviewer-child completion before marking the workflow complete.

Assess: contract adherence, evidence quality, hallucination risk against provided artifacts, and whether work is complete.

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
- Evidence quality: outputs with concrete indicators (file paths, line numbers, error messages, data) are more trustworthy than vague summaries
- Hallucination check: if output claims "according to logs" or "as seen in" but doesn't match known artifacts, flag it
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

// ============================================================================
// Evidence & hallucination helpers (ported from agenc-core)
// ============================================================================

/**
 * Check if output text intersects with known artifact paths.
 * If the output references things not in the artifact list, it may be hallucinated.
 */
function outputIntersectsArtifacts(outputLower: string, artifacts: readonly string[]): boolean {
  if (artifacts.length === 0) return true // no artifacts to check against
  return artifacts.some(artifact => {
    const normalizedArtifact = artifact.toLowerCase().replace(/^\.\//, "")
    // Check if any basename or partial path from the artifact appears in output
    const basename = normalizedArtifact.split("/").pop() ?? normalizedArtifact
    return outputLower.includes(basename) || outputLower.includes(normalizedArtifact)
  })
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
