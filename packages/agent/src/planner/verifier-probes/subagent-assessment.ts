/**
 * Per-subagent-step deterministic assessment — extracted from
 * verifier-probes.ts to keep the runDeterministicProbes loop readable.
 *
 * @module
 */

import type { Tool } from "../../types.js"
import type {
    PipelineResult,
    PipelineStepResult,
    Plan,
    SubagentTaskStep,
    VerifierStepAssessment,
} from "../types.js"
import { buildStepSpecEvidence } from "../verifier-blueprint.js"
import {
    computeGibberishScore,
    isBlockingCriteriaProofGap,
    outputIntersectsArtifacts,
    safeParseJson
} from "../verifier-helpers.js"
import {
    extractActualPaths,
    probeArtifact,
    readArtifactContent,
} from "../verifier-io.js"
import { detectVerificationModalityGaps } from "../verifier-llm.js"
import { probeContentCompleteness, probeCriteriaProof } from "../verifier-probes-subprobes.js"
import { runBrowserCheckProbe, runTestsProbe } from "./runtime-probes.js"
import { detectPathMismatchIssues, detectScopeViolationIssues } from "./scope-checks.js"

const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
const EVIDENCE_DENSITY_RE = /(line|file|log|trace|stderr|stdout|stack|error|\d)/i
const HALLUCINATION_CLAIM_RE = /(according to|as seen in|from the logs|based on)/i

const STRUCTURAL_KEYWORDS = [
  "not found", "Placeholder", "stub", "Syntax error", "Corrupted",
  "Missing method", "Browser check", "catch-all", "empty function",
  "deferred-work", "explicit failure", "all tool calls failed",
  "zero tool calls", "gibberish", "skeletal", "inconsistent branch",
  "degeneration", "PATH MISMATCH", "SCOPE VIOLATION",
  "VERIFICATION MODALITY GAP", "CRITERIA PROOF MISSING",
  "SPEC ", "PROCESS AUDIT", "BLUEPRINT ARTIFACT",
  "BLUEPRINT FUNCTION CONTRACT", "BLUEPRINT SHARED TYPE",
]

export async function assessSubagentStep(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult,
  plan: Plan,
  pipelineResult: PipelineResult,
  toolMap: Map<string, Tool>,
): Promise<VerifierStepAssessment> {
  void pipelineResult
  const sa = step
  const issues: string[] = []
  const outputText = (stepResult.output ?? "").trim()
  const executedModalities = new Set<string>()
  const actualPaths = extractActualPaths(outputText)

  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  const wsRoot = sa.executionContext.workspaceRoot || undefined
  const probeCache = new Map<string, { found: boolean; resolvedPath: string }>()
  if (readFile && sa.executionContext.targetArtifacts.length > 0) {
    for (const artifact of sa.executionContext.targetArtifacts) {
      const probe = await probeArtifact(readFile, artifact, actualPaths, wsRoot, runCommand, sa.executionContext.allowedWriteRoots)
      probeCache.set(artifact, probe)
      if (!probe.found) {
        issues.push(`Target artifact "${artifact}" not found`)
      } else {
        executedModalities.add("artifact-review")
      }
    }
  }

  if (readFile) {
    const specEvidence = await buildStepSpecEvidence(sa, stepResult, plan, readFile, readArtifactContent, probeArtifact, runCommand, actualPaths)
    if (specEvidence) {
      issues.push(...specEvidence.structuralIssues)
      issues.push(...specEvidence.processAuditIssues)
    }
  }

  // Path mismatch + scope violation detection
  issues.push(...detectPathMismatchIssues(probeCache, wsRoot))
  issues.push(...detectScopeViolationIssues(sa, plan, outputText, wsRoot))

  // Runtime probes: browser_check + run_tests
  const browserOutcome = await runBrowserCheckProbe(sa, toolMap, probeCache, wsRoot, issues, executedModalities)
  const browserCheckPassed = browserOutcome.passed
  const htmlArtifacts = browserOutcome.htmlArtifacts
  await runTestsProbe(sa, toolMap, issues, executedModalities)

  // Content completeness probe
  if (readFile && sa.executionContext.targetArtifacts.length > 0) {
    await probeContentCompleteness(sa, readFile, runCommand, probeCache, issues, executedModalities)
  }

  // Evidence density scoring
  const outputLower = outputText.toLowerCase()
  if (outputText.length > 0 && !EVIDENCE_DENSITY_RE.test(outputLower)) {
    issues.push("Weak evidence density: output lacks concrete indicators (file paths, line numbers, errors, data)")
  }

  // Hallucination detection
  if (
    outputText.length > 0 &&
    HALLUCINATION_CLAIM_RE.test(outputLower) &&
    !outputIntersectsArtifacts(outputLower, sa.executionContext.targetArtifacts)
  ) {
    issues.push("Hallucination risk: output references artifacts/logs but claims don't match known targets")
  }

  // Tool-call consistency
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

  // Criteria proof checks
  probeCriteriaProof(sa, outputText, executedModalities, issues)

  // General verification modality coverage
  const modalityGaps = detectVerificationModalityGaps(sa, executedModalities, toolMap)
  issues.push(...modalityGaps)

  // Gibberish detection
  if (outputText.length > 20) {
    const gibberishScore = computeGibberishScore(outputText)
    if (gibberishScore >= 0.6) {
      issues.push("Child output appears to be gibberish/word-salad — no coherent implementation summary")
    }
  }

  // Role-specific validation
  const role = sa.executionContext.role ?? "writer"
  if (role === "writer") {
    let mutationConfirmed = false
    for (const artifact of sa.executionContext.targetArtifacts) {
      const cached = probeCache.get(artifact)
      if (cached?.found) { mutationConfirmed = true; break }
    }
    if (!mutationConfirmed && sa.executionContext.targetArtifacts.length > 0) {
      if (!issues.some(i => i.includes("not found"))) {
        issues.push("Writer step may lack mutation evidence — target artifacts not found on disk")
      }
    }
  }

  // Shared-state contract
  const shared = sa.executionContext.sharedStateContract
  if (shared) {
    if (sa.name !== shared.ownerStepName) {
      const required = new Set(sa.executionContext.requiredSourceArtifacts.map(a => a.replace(/^\.\//, "")))
      const ownerArtifact = shared.ownerArtifactPath.replace(/^\.\//, "")
      if (!required.has(ownerArtifact)) {
        issues.push(
          `CRITERIA PROOF MISSING: shared-state contract requires consuming owner artifact "${shared.ownerArtifactPath}", but it is missing from requiredSourceArtifacts`,
        )
      }
    }
  }

  const structuralIssues = issues.filter(i =>
    STRUCTURAL_KEYWORDS.some(kw => i.toLowerCase().includes(kw.toLowerCase())),
  )
  const nonStructuralIssues = issues.filter(i =>
    !STRUCTURAL_KEYWORDS.some(kw => i.toLowerCase().includes(kw.toLowerCase())),
  )

  let effectiveIssueCount = issues.length
  if (browserCheckPassed && structuralIssues.length === 0) {
    effectiveIssueCount = 0
  } else if (browserCheckPassed && structuralIssues.length < issues.length) {
    effectiveIssueCount = structuralIssues.length
  }

  const hasBlockingGap = issues.some(isBlockingCriteriaProofGap)
  const confidence = Math.max(0, 1 - Math.min(0.9, effectiveIssueCount * 0.18))
  const outcome = hasBlockingGap
    ? "fail" as const
    : effectiveIssueCount > 0
      ? (confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE ? "fail" as const : "retry" as const)
      : "pass" as const

  const positiveSignals: string[] = []
  if (browserCheckPassed) {
    const htmlNames = htmlArtifacts.map(a => a.split("/").pop()).join(", ")
    positiveSignals.push(`browser_check: ✓ all HTML artifacts load without errors (${htmlNames})`)
  }

  return {
    stepName: step.name,
    outcome,
    confidence,
    issues: effectiveIssueCount < issues.length
      ? [...structuralIssues, ...nonStructuralIssues.map(i => `[non-blocking] ${i}`)]
      : issues,
    retryable: !hasBlockingGap,
    positiveSignals: positiveSignals.length > 0 ? positiveSignals : undefined,
  }
}
