/**
 * Verifier deterministic probes — file existence, build, test, content
 * completeness, and role-specific validation.
 *
 * Extracted from verifier.ts.
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
import { buildStepSpecEvidence } from "./verifier-blueprint.js"
import {
    computeGibberishScore,
    isBlockingCriteriaProofGap,
    outputIntersectsArtifacts,
    safeParseJson
} from "./verifier-helpers.js"
import { runIntegrationProbes } from "./verifier-integration.js"
import {
    executeToolForText,
    extractActualPaths,
    probeArtifact,
    readArtifactContent,
} from "./verifier-io.js"
import { detectVerificationModalityGaps } from "./verifier-llm.js"
import { probeContentCompleteness, probeCriteriaProof } from "./verifier-probes-subprobes.js"

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65
const EVIDENCE_DENSITY_RE = /(line|file|log|trace|stderr|stdout|stack|error|\d)/i
const HALLUCINATION_CLAIM_RE = /(according to|as seen in|from the logs|based on)/i

// ============================================================================
// Deterministic probes
// ============================================================================

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

      // Path mismatch detection
      for (const [artifact, probe] of probeCache) {
        if (!probe.found) continue
        const normPlanned = artifact.replace(/^\.\//, "")
        const normResolved = probe.resolvedPath.replace(/^\.\//, "")
        if (normResolved !== normPlanned) {
          const stripped = wsRoot
            ? normResolved.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
            : normResolved
          if (stripped !== normPlanned) {
            issues.push(
              `PATH MISMATCH: artifact "${artifact}" was found at "${probe.resolvedPath}" instead of the planned path. ` +
              `The child wrote to the WRONG directory. HTML and other files reference the planned path, so this file will NOT be loaded. ` +
              `The child must write to the EXACT path specified in targetArtifacts.`
            )
          }
        }
      }

      // Off-target write detection
      const targetSet = new Set(sa.executionContext.targetArtifacts.map(a => a.replace(/^\.\//, "")))
      const allowedIntegrationWriteSet = new Set(
        sa.executionContext.requiredSourceArtifacts.map(a => a.replace(/^\.\//, "")),
      )
      const writtenPathsForScopeCheck = new Set<string>()
      for (const m of outputText.matchAll(/(?:creat|writ|wrote|modif|generat|saved)\w*\s+(?:to\s+)?(?:file\s+)?["']?([^\s"'`,]+\.[a-zA-Z0-9]+)/gi)) {
        if (m[1] && m[1].length < 200) writtenPathsForScopeCheck.add(m[1])
      }
      for (const actual of writtenPathsForScopeCheck) {
        const normActual = actual.replace(/^\.\//, "")
        const stripped = wsRoot
          ? normActual.replace(new RegExp(`^${wsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "")
          : normActual
        if (allowedIntegrationWriteSet.has(stripped) || allowedIntegrationWriteSet.has(normActual)) continue
        if (!targetSet.has(stripped) && !targetSet.has(normActual)) {
          const ownedByOtherStep = plan.steps.some(s => {
            if (s.name === step.name || s.stepType !== "subagent_task") return false
            const other = s as SubagentTaskStep
            return other.executionContext.targetArtifacts.some(
              a => a.replace(/^\.\//, "") === stripped || a.replace(/^\.\//, "") === normActual
            )
          })
          if (ownedByOtherStep) {
            issues.push(
              `SCOPE VIOLATION: Child wrote to "${actual}" which belongs to a DIFFERENT step's targetArtifacts. ` +
              `Each step must ONLY write to its own target files. Writing to other steps' files causes overwrites and data loss.`
            )
          }
        }
      }

      // Runtime probe: browser_check for HTML artifacts
      let browserCheckPassed = false
      const htmlArtifacts = sa.executionContext.targetArtifacts.filter(
        a => a.endsWith(".html") || a.endsWith(".htm"),
      )
      if (htmlArtifacts.length > 0) {
        const browserCheck = toolMap.get("browser_check")
        if (browserCheck) {
          let anyBrowserFailure = false
          for (const html of htmlArtifacts) {
            const cached = probeCache.get(html)
            let browserPath = cached?.found ? cached.resolvedPath : html
            if (wsRoot && browserPath.startsWith(wsRoot)) {
              browserPath = browserPath.slice(wsRoot.length).replace(/^\//, "")
            }
            try {
              executedModalities.add("runtime")
              const result = await executeToolForText(browserCheck, { path: browserPath })
              if (/error|fail|exception/i.test(result) && !/no errors/i.test(result)) {
                const isBackendNotRunningLine = (ln: string): boolean =>
                  /ERR_CONNECTION_REFUSED|net::ERR_CONNECTION|Failed to fetch/i.test(ln) ||
                  (/(404|Not Found)/i.test(ln) && /(localhost|127\.0\.0\.1)[:/]/i.test(ln))
                const allErrorsAreBackendNotRunning = result
                  .split("\n")
                  .filter(ln => /error|fail|exception/i.test(ln))
                  .every(ln => isBackendNotRunningLine(ln))
                if (!allErrorsAreBackendNotRunning) {
                  issues.push(`Browser check for "${browserPath}" reported errors: ${result.slice(0, 300)}`)
                  anyBrowserFailure = true
                }
              }
            } catch {
              issues.push(`Browser check failed for "${browserPath}"`)
              anyBrowserFailure = true
            }
          }
          if (!anyBrowserFailure) {
            browserCheckPassed = true
          }
        } else {
          issues.push("VERIFICATION MODALITY GAP: HTML artifacts exist but browser_check tool is unavailable, so runtime verification could not run")
        }
      }

      // Run tests if verification mode is run_tests
      if (sa.executionContext.verificationMode === "run_tests") {
        const runCmd = toolMap.get("run_command")
        if (runCmd) {
          try {
            executedModalities.add("runtime")
            const result = await executeToolForText(runCmd, { command: "npm test 2>&1 || exit 0" })
            if (/\d+\s+fail|FAIL\s|tests?\s+failed/i.test(result) && !/0 failed/i.test(result)) {
              issues.push(`Test run reported failures: ${result.slice(0, 300)}`)
            }
          } catch {
            issues.push("Test run failed to execute")
          }
        }
      }

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

      // Confidence from issue count
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

      // Collect definitive positive signals from deterministic probes.
      // These are passed to the LLM verifier so it can weigh them against
      // uncertainty-based issues (e.g. "cannot verify completeness due to truncation").
      const positiveSignals: string[] = []
      if (browserCheckPassed) {
        const htmlNames = htmlArtifacts.map(a => a.split("/").pop()).join(", ")
        positiveSignals.push(`browser_check: ✓ all HTML artifacts load without errors (${htmlNames})`)
      }

      assessments.push({
        stepName: step.name,
        outcome,
        confidence,
        issues: effectiveIssueCount < issues.length
          ? [...structuralIssues, ...nonStructuralIssues.map(i => `[non-blocking] ${i}`)]
          : issues,
        retryable: !hasBlockingGap,
        positiveSignals: positiveSignals.length > 0 ? positiveSignals : undefined,
      })
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
