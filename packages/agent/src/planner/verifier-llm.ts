/**
 * Verifier code structure analysis — deterministic import/declaration
 * extraction and LLM verification wrapper.
 *
 * Extracted from verifier.ts.
 *
 * @module
 */

import type { LLMClient, Message, Tool } from "../types.js"
import type {
    PipelineResult,
    Plan,
    SubagentTaskStep,
    VerifierDecision,
    VerifierStepAssessment,
} from "./types.js"
import type { StepSpecEvidence } from "./verifier-blueprint.js"
import { buildFallbackDecision, parseLLMVerification } from "./verifier-helpers.js"
import {
    analyzeCodeStructure,
    wrapArtifactWithStructureAnalysis,
} from "./verifier-llm/code-structure.js"
export { analyzeCodeStructure, wrapArtifactWithStructureAnalysis }
export type { CodeStructureAnalysis } from "./verifier-llm/code-structure.js"

// ============================================================================
// Code structure analysis lives in verifier-llm/code-structure.ts
// ============================================================================

// ============================================================================
// Verification modality gap detection
// ============================================================================

export function detectVerificationModalityGaps(
  step: SubagentTaskStep,
  executedModalities: ReadonlySet<string>,
  toolMap: Map<string, Tool>,
): string[] {
  const issues: string[] = []
  const artifacts = step.executionContext.targetArtifacts
  const docsOnlyArtifacts = artifacts.length > 0 && artifacts.every(a => /\.(?:md|markdown|txt|rst|adoc)$/i.test(a))
  const hasHtml = artifacts.some(a => /\.html?$/i.test(a))
  const hasCode = artifacts.some(a => /\.(?:js|jsx|ts|tsx|py|rb|java|cs|go|rs|c|cpp|swift|kt|php)$/i.test(a))

  const criteriaText = [step.objective, ...step.acceptanceCriteria].join(" ").toLowerCase()
  const INTERACTION_RUNTIME_RE = /\b(?:click|submit|drag|drop|keyboard|mouse|navigate|interactive|render|display|preview|execute|run|workflow|integration|e2e|end[- ]to[- ]end)\b/i
  const IO_RUNTIME_RE = /\b(?:api|request|response|endpoint|fetch|http|rpc|query|database|sql|persist|sync|connect|auth|login|permission)\b/i

  const requiresArtifactReview = artifacts.length > 0
  const requiresSyntax = hasCode
  const requiresRuntime = !docsOnlyArtifacts && (hasHtml || INTERACTION_RUNTIME_RE.test(criteriaText) || IO_RUNTIME_RE.test(criteriaText))

  if (requiresArtifactReview && !executedModalities.has("artifact-review")) {
    if (toolMap.has("read_file")) {
      issues.push("VERIFICATION MODALITY GAP: target artifacts were produced but no deterministic artifact read/review probe ran")
    }
  }

  if (requiresSyntax && !executedModalities.has("syntax")) {
    if (toolMap.has("run_command")) {
      issues.push("VERIFICATION MODALITY GAP: code artifacts exist but no syntax/compile probe ran")
    } else {
      issues.push("VERIFICATION MODALITY GAP: code artifacts exist but syntax probe could not run (run_command unavailable)")
    }
  }

  if (requiresRuntime && !executedModalities.has("runtime")) {
    if (hasHtml && !toolMap.has("browser_check")) {
      issues.push("VERIFICATION MODALITY GAP: runtime behavior required for HTML output but browser_check tool is unavailable")
    } else {
      issues.push("VERIFICATION MODALITY GAP: acceptance criteria imply runtime behavior, but no runtime probe (browser_check/tests/command) ran")
    }
  }

  return issues
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
- "pass" means the step completed and produced REAL, WORKING implementation that meets the core objective
- "retry" means the step produced output but has clear, concrete deficiencies that a retry could fix
- "fail" means the step fundamentally failed (error, no output, wrong approach entirely)
- SKELETON / PLACEHOLDER CODE IS NEVER "pass": If a step was supposed to implement logic but output contains placeholder functions, mark it "retry"
- LLM DEGENERATION IS NEVER "pass": Comments like \`// Other code as per existing logic\`, \`// rest of the code here\` mean the LLM skipped generating actual code
- SHALLOW IMPLEMENTATION IS NEVER "pass": If acceptance criteria require complex logic but code only has trivial implementations, mark it "retry"
- CODE LENGTH IS NOT A QUALITY METRIC: Compact, correct code is FINE
- IMPORT AND KEYWORD ANALYSIS IS PRE-CHECKED: Trust PRE-CHECKED STRUCTURE blocks in artifact sections
- TRUNCATION IS NOT INCOMPLETENESS: Files shown with "(truncated — head+tail)" are COMPLETE on disk. The head+tail view lets you verify correct start and end. Do NOT flag a file as incomplete, unverifiable, or suspect solely because it was truncated for context. Truncation is a display constraint, not a quality signal.
- POSITIVE SIGNAL OVERRIDE (MANDATORY): If a step's deterministicResult includes positiveSignals with "browser_check: ✓" or "syntax: ✓", you MUST NOT raise issues about "cannot verify completeness", "truncated evidence makes verification impossible", or "acceptance criterion cannot be verified from excerpt". Those signals are definitive proof the artifact is loadable/syntactically correct. Only raise real semantic issues (wrong logic, missing gameplay rules, etc.) that you can actually see in the artifact content.
- confidence is 0.0 to 1.0
- Respond ONLY with the JSON object`

export async function runLLMVerification(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  deterministicAssessments: readonly VerifierStepAssessment[],
  opts?: {
    signal?: AbortSignal
    onTrace?: (entry: Record<string, unknown>) => void
    artifactContents?: ReadonlyMap<string, string>
    stepSpecEvidence?: ReadonlyMap<string, StepSpecEvidence>
  },
): Promise<VerifierDecision> {
  const stepSummaries = plan.steps.map(step => {
    const result = pipelineResult.stepResults.get(step.name)
    const detAssessment = deterministicAssessments.find(a => a.stepName === step.name)
    const specEvidence = opts?.stepSpecEvidence?.get(step.name)

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
        // Definitive positive signals from deterministic probes.
        // When present, do NOT raise truncation/completeness blocking issues.
        positiveSignals: detAssessment.positiveSignals ?? [],
      } : undefined,
      specEvidence: specEvidence ? {
        blueprintPath: specEvidence.blueprintPath,
        sourceReads: specEvidence.sourceReads,
        contractSharedTypes: specEvidence.contractSharedTypes.map((type) => ({
          name: type.name,
          definition: type.definition,
          usedBy: type.usedBy,
        })),
        sharedTypes: specEvidence.sharedTypes,
        algorithmicContracts: specEvidence.algorithmicContracts,
        mappings: specEvidence.mappings.map(mapping => ({
          targetArtifact: mapping.targetArtifact,
          actualArtifactPath: mapping.actualArtifactPath,
          matchedSpecPath: mapping.matchedSpecPath,
          pathMatch: mapping.pathMatch,
          foundFunctions: mapping.foundFunctions,
          missingFunctions: mapping.missingFunctions,
          foundStructuralMarkers: mapping.foundStructuralMarkers,
          missingStructuralMarkers: mapping.missingStructuralMarkers,
        })),
        structuralIssues: specEvidence.structuralIssues,
        processAuditIssues: specEvidence.processAuditIssues,
      } : undefined,
    }
  })

  let artifactSection = ""
  if (opts?.artifactContents && opts.artifactContents.size > 0) {
    const parts: string[] = []
    for (const [path, content] of opts.artifactContents) {
      const totalBudget = 24_000
      const perArtifactLimit = Math.max(4000, Math.floor(totalBudget / opts.artifactContents.size))
      let displayContent: string
      let sizeNote = ""
      if (content.length > perArtifactLimit) {
        // Show head (75%) + tail (25%) so the verifier can confirm the file
        // both starts and ends correctly. A file complete on disk will have a
        // proper closing brace/statement in its tail.
        const lineCount = content.split("\n").length
        const headChars = Math.floor(perArtifactLimit * 0.75)
        const tailChars = perArtifactLimit - headChars
        const omittedChars = content.length - headChars - tailChars
        const head = content.slice(0, headChars)
        const tail = content.slice(-tailChars)
        displayContent = `${head}\n... (${omittedChars} chars omitted) ...\n${tail}`
        sizeNote = `File size: ${content.length} chars, ${lineCount} lines. TRUNCATED (head+tail shown — file is COMPLETE on disk, only display is trimmed).\n`
      } else {
        displayContent = content
      }
      parts.push(wrapArtifactWithStructureAnalysis(path, displayContent, sizeNote))
    }
    artifactSection = `\n\n## Actual File Contents\nEach file includes a PRE-CHECKED STRUCTURE block. Trust that data — do NOT re-analyze imports or flag language keywords. Focus on semantic correctness against acceptance criteria.\n\n${parts.join("\n\n")}`
  }

  const messages: Message[] = [
    { role: "system", content: VERIFIER_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Verify the following plan execution results:\n\nPlan reason: ${plan.reason}\n\nStep results:\n${JSON.stringify(stepSummaries, null, 2)}${artifactSection}`,
    },
  ]

  opts?.onTrace?.({
    kind: "llm-request",
    iteration: -1,
    messageCount: messages.length,
    toolCount: 0,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      toolCalls: [],
      toolCallId: null,
    })),
  })

  try {
    const t0 = Date.now()
    const response = await llm.chat(messages, [], { signal: opts?.signal })
    const durationMs = Date.now() - t0

    opts?.onTrace?.({
      kind: "llm-response",
      iteration: -1,
      durationMs,
      content: response.content,
      toolCalls: [],
      usage: response.usage ?? null,
    })

    if (!response.content) {
      return buildFallbackDecision(deterministicAssessments)
    }

    const rawDecision = parseLLMVerification(response.content, deterministicAssessments)

    // Post-process: when deterministic probes gave positive signals (e.g. browser_check ✓),
    // downgrade any LLM issues that are purely uncertainty-based due to truncation.
    // These are false positives — the file works, the LLM just couldn't see its tail.
    const TRUNCATION_UNCERTAINTY_RE = /truncat|cannot verify.*complet|excerpt.*missing|complet.*unverif|acceptance.*criterion.*cannot.*verif|grounded.*evidence.*shows.*truncat|critical tail.*missing/i
    const downgraded = rawDecision.steps.map(step => {
      const detAssessment = deterministicAssessments.find(a => a.stepName === step.stepName)
      if (!detAssessment?.positiveSignals?.length) return step
      const hasStrongSignal = detAssessment.positiveSignals.some(s => /browser_check.*✓|syntax.*✓/i.test(s))
      if (!hasStrongSignal) return step
      const processedIssues = step.issues.map(issue =>
        !issue.startsWith("[non-blocking]") && TRUNCATION_UNCERTAINTY_RE.test(issue)
          ? `[non-blocking] ${issue}`
          : issue
      )
      const remainingBlocking = processedIssues.filter(i => !i.startsWith("[non-blocking]"))
      return {
        ...step,
        issues: processedIssues,
        outcome: remainingBlocking.length === 0 ? "pass" as const : step.outcome,
      }
    })

    const anyRetry = downgraded.some(s => s.outcome === "retry")
    const anyFail = downgraded.some(s => s.outcome === "fail")
    return {
      ...rawDecision,
      overall: anyFail ? "fail" : anyRetry ? "retry" : "pass",
      steps: downgraded,
    }
  } catch {
    return buildFallbackDecision(deterministicAssessments)
  }
}
