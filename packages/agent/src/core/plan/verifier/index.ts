import { PipelineStatus, PlannerTraceKind, VerifierOutcome } from "../../domain/index.js"
/**
 * Verifier — post-pipeline verification of execution results.
 *
 * Two-phase verification (agenc-core pattern):
 *   1. Deterministic probes — check file existence, run build/test commands
 *   2. LLM-based assessment — structured confidence check per step
 *
 * The bulk of the implementation lives in sub-modules:
 *   - verifier-probes.ts — deterministic probes
 *   - verifier-llm.ts — LLM verification
 *   - verifier-helpers.ts — parsing, corruption detection, utility helpers
 *   - verifier-blueprint.ts — blueprint spec analysis
 *   - verifier-integration.ts — cross-file integration probes
 *   - verifier-io.ts — file I/O for verification
 *
 * @module
 */

import type { LLMClient, Tool } from "../../types.js"
import { uniqueStrings } from "../blueprint-contract/index.js"
import type { StepSpecEvidence } from "../internal/verifier-blueprint.js"
import { buildStepSpecEvidence } from "../internal/verifier-blueprint.js"
import { extractActualPaths, probeArtifact, readArtifactContent } from "../internal/verifier-io.js"
import { runLLMVerification } from "../internal/verifier-llm.js"
import { runDeterministicProbes } from "../internal/verifier-probes.js"
import type {
  PipelineResult,
  Plan,
  SubagentTaskStep,
  VerificationEvidence,
  VerifierDecision,
  VerifierStepAssessment
} from "../types.js"
import {
  buildSystemChecks,
  collectVerificationEvidence,
  deriveIssuesFromEvidence
} from "../verification-model/index.js"
import { buildFallbackDecision } from "../verifier-helpers/index.js"
import { runContractValidation } from "./contract-check.js"
import {
  collectFollowupEvidence,
  mergeFollowupIntoAssessments,
  needsFollowupVerification
} from "./followup.js"

// ============================================================================
// Re-exports — public API surface
// ============================================================================

export { runLLMVerification } from "../internal/verifier-llm.js"
export { runDeterministicProbes } from "../internal/verifier-probes.js"
export { isLLMGibberish } from "../verifier-helpers/index.js"

// ============================================================================
// Follow-up verification helpers live in verifier/followup.ts
// ============================================================================

// ============================================================================
// Main verify orchestrator
// ============================================================================

export async function verify(
  llm: LLMClient,
  plan: Plan,
  pipelineResult: PipelineResult,
  tools: readonly Tool[],
  opts?: {
    signal?: AbortSignal
    onTrace?: (entry: Record<string, unknown>) => void
    skipContractValidation?: boolean
  }
): Promise<VerifierDecision> {
  const finalizeAssessments = (
    assessments: readonly VerifierStepAssessment[],
    source: VerificationEvidence["source"]
  ): VerifierStepAssessment[] => {
    const evidenceByStep = collectVerificationEvidence(plan, assessments, source)
    const issuesByStep = deriveIssuesFromEvidence(plan, assessments, evidenceByStep)
    return assessments.map((assessment) => ({
      ...assessment,
      evidence: [...(evidenceByStep.get(assessment.stepName) ?? [])],
      issueDetails: [...(issuesByStep.get(assessment.stepName) ?? [])]
    }))
  }

  const knownProjectArtifacts = plan.steps
    .filter((s): s is SubagentTaskStep => s.stepType === "subagent_task")
    .flatMap((s) => s.executionContext.targetArtifacts)

  // Phase 0: Delegation output contract validation
  const contractFailures = opts?.skipContractValidation
    ? []
    : runContractValidation(plan, pipelineResult, { knownProjectArtifacts, onTrace: opts?.onTrace })

  // If contract validation caught issues, return immediately (no LLM needed)
  if (contractFailures.length > 0) {
    const allSteps: VerifierStepAssessment[] = []
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const contractFail = contractFailures.find((cf) => cf.stepName === step.name)
      if (contractFail) {
        allSteps.push(contractFail)
      } else {
        const sr = pipelineResult.stepResults.get(step.name)
        if (sr && sr.status === PipelineStatus.Completed) {
          allSteps.push({
            stepName: step.name,
            outcome: VerifierOutcome.Pass,
            confidence: 0.8,
            issues: [],
            retryable: false
          })
        }
      }
    }
    const enrichedSteps = finalizeAssessments(allSteps, "contract")
    return {
      overall: VerifierOutcome.Retry,
      confidence: Math.min(...enrichedSteps.map((s) => s.confidence)),
      steps: enrichedSteps,
      unresolvedItems: contractFailures.map((cf) => cf.issues[0])
    }
  }

  // Phase 1: Deterministic probes
  const detAssessments = finalizeAssessments(
    await runDeterministicProbes(plan, pipelineResult, tools),
    "deterministic"
  )

  // If deterministic probes already show clear failure, skip LLM verification
  const detFails = detAssessments.filter(
    (a) => a.outcome === VerifierOutcome.Fail || a.outcome === VerifierOutcome.Retry
  )
  if (detFails.length > 0 && detFails.some((a) => a.outcome === VerifierOutcome.Fail)) {
    return buildFallbackDecision(detAssessments)
  }

  // Read actual file contents for code artifacts to give the LLM verifier
  // concrete code to assess (not just the child's self-reported output).
  // Re-use a per-path content cache so each file is read at most once across
  // the deterministic-probe phase and this LLM-prep phase.
  const artifactContents = new Map<string, string>()
  const stepSpecEvidence = new Map<string, StepSpecEvidence>()
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  const readFile = toolMap.get("read_file")
  const runCommand = toolMap.get("run_command")
  // Content cache: populated on first read, reused on subsequent reads.
  const contentCache = new Map<string, string | null>()
  async function cachedReadArtifactContent(path: string): Promise<string | null> {
    if (contentCache.has(path)) return contentCache.get(path)!
    const result = readFile ? await readArtifactContent(readFile, path, runCommand) : null
    contentCache.set(path, result)
    return result
  }
  if (readFile) {
    for (const step of plan.steps) {
      if (step.stepType !== "subagent_task") continue
      const sa = step as SubagentTaskStep
      const stepResult = pipelineResult.stepResults.get(step.name)
      if (stepResult?.status === PipelineStatus.Completed) {
        const actualPaths = stepResult.output ? extractActualPaths(stepResult.output) : []
        const specEvidence = await buildStepSpecEvidence(
          sa,
          stepResult,
          plan,
          readFile,
          readArtifactContent,
          probeArtifact,
          runCommand,
          actualPaths
        )
        if (specEvidence) stepSpecEvidence.set(step.name, specEvidence)
      }
      const actualPaths = stepResult?.output ? extractActualPaths(stepResult.output) : []
      for (const artifact of sa.executionContext.targetArtifacts) {
        if (!/\.(js|jsx|ts|tsx|html|css|py)$/i.test(artifact)) continue
        const probe = await probeArtifact(
          readFile,
          artifact,
          actualPaths,
          sa.executionContext.workspaceRoot || undefined,
          runCommand,
          sa.executionContext.allowedWriteRoots
        )
        if (probe.found) {
          try {
            const content = await cachedReadArtifactContent(probe.resolvedPath)
            if (typeof content === "string" && content.length > 0) {
              artifactContents.set(artifact, content)
            }
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  // Phase 2: LLM verification
  const decision = await runLLMVerification(llm, plan, pipelineResult, detAssessments, {
    signal: opts?.signal,
    onTrace: opts?.onTrace,
    artifactContents,
    stepSpecEvidence
  })

  // Merge: if deterministic says "retry" but LLM says "pass", trust deterministic
  const mergedSteps = decision.steps.map((llmStep) => {
    const detStep = detAssessments.find((d) => d.stepName === llmStep.stepName)
    if (detStep && detStep.outcome !== VerifierOutcome.Pass && llmStep.outcome === VerifierOutcome.Pass) {
      const allNonBlocking = detStep.issues.every((i) => i.startsWith("[non-blocking]"))
      if (allNonBlocking && detStep.issues.length > 0) {
        return { ...llmStep, issues: [...llmStep.issues, ...detStep.issues] }
      }
      return { ...detStep }
    }
    return llmStep
  })

  const anyRetry = mergedSteps.some((s) => s.outcome === VerifierOutcome.Retry)
  const anyFail = mergedSteps.some((s) => s.outcome === VerifierOutcome.Fail)
  let enrichedMergedSteps = finalizeAssessments(mergedSteps, "llm")
  const followupCandidates = needsFollowupVerification(enrichedMergedSteps)
  if (followupCandidates.length > 0) {
    opts?.onTrace?.({
      kind: PlannerTraceKind.VerificationFollowup,
      requestedSteps: followupCandidates.map((assessment) => assessment.stepName),
      reasons: followupCandidates.map((assessment) => ({
        stepName: assessment.stepName,
        confidence: assessment.confidence,
        ambiguousIssues: (assessment.issueDetails ?? [])
          .filter((issue) => issue.ownershipMode !== "deterministic_owner")
          .map((issue) => issue.code)
      }))
    })
    const followupEvidenceByStep = collectFollowupEvidence(plan, pipelineResult, followupCandidates)
    enrichedMergedSteps = mergeFollowupIntoAssessments(plan, enrichedMergedSteps, followupEvidenceByStep)
  }

  const systemChecks = buildSystemChecks({
    overall: anyFail ? VerifierOutcome.Fail : anyRetry ? VerifierOutcome.Retry : VerifierOutcome.Pass,
    confidence: Math.min(decision.confidence, ...enrichedMergedSteps.map((s) => s.confidence)),
    steps: enrichedMergedSteps,
    unresolvedItems: decision.unresolvedItems
  })

  return {
    overall: anyFail ? VerifierOutcome.Fail : anyRetry ? VerifierOutcome.Retry : VerifierOutcome.Pass,
    confidence: Math.min(decision.confidence, ...enrichedMergedSteps.map((s) => s.confidence)),
    steps: enrichedMergedSteps,
    unresolvedItems: uniqueStrings([
      ...decision.unresolvedItems,
      ...systemChecks.map((check) => check.summary)
    ]),
    systemChecks
  }
}
