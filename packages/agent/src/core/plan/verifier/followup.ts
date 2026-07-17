/**
 * Follow-up verification — extra evidence collection for low-confidence
 * assessments after the LLM verifier returns.
 *
 * @module
 */

import { VerifierEvidenceSource } from "../../../domain/index.js"
import { uniqueStrings } from "../blueprint-contract/index.js"
import type { PipelineResult, Plan, VerificationEvidence, VerifierStepAssessment } from "../types.js"
import { deriveIssuesFromEvidence } from "../verification-model/index.js"

export function needsFollowupVerification(
  assessments: readonly VerifierStepAssessment[]
): VerifierStepAssessment[] {
  return assessments.filter((assessment) => {
    if (assessment.confidence < 0.7) return true
    return (assessment.issueDetails ?? []).some(
      (issue) => issue.confidence < 0.7 || issue.ownershipMode !== "deterministic_owner"
    )
  })
}

export function collectFollowupEvidence(
  plan: Plan,
  pipelineResult: PipelineResult,
  assessments: readonly VerifierStepAssessment[]
): Map<string, VerificationEvidence[]> {
  const followup = new Map<string, VerificationEvidence[]>()

  for (const assessment of assessments) {
    const step = plan.steps.find((candidate) => candidate.name === assessment.stepName)
    if (step?.stepType !== "subagent_task") continue
    const stepResult = pipelineResult.stepResults.get(assessment.stepName)
    const evidence: VerificationEvidence[] = []
    const reconciliation = stepResult?.reconciliation
    if (reconciliation) {
      reconciliation.findings.forEach((finding, index) => {
        evidence.push({
          id: `${assessment.stepName}:followup:reconciliation:${index + 1}`,
          stepName: assessment.stepName,
          source: VerifierEvidenceSource.Deterministic,
          kind: finding.code,
          message: finding.message,
          artifactPaths: [...finding.artifactPaths],
          details: { severity: finding.severity, phase: "reconciliation" }
        })
      })
    }
    const verificationAttempts = stepResult?.verificationAttempts ?? []
    if (verificationAttempts.length > 0) {
      verificationAttempts.forEach((attempt, index) => {
        if (attempt.success) return
        evidence.push({
          id: `${assessment.stepName}:followup:verification:${index + 1}`,
          stepName: assessment.stepName,
          source: VerifierEvidenceSource.Deterministic,
          kind: "verification_attempt_failure",
          message: `${attempt.toolName}${attempt.target ? `:${attempt.target}` : ""} failed: ${attempt.summary}`,
          artifactPaths: attempt.target ? [attempt.target] : [],
          details: { phase: "followup_verification" }
        })
      })
    }
    if (evidence.length > 0) followup.set(assessment.stepName, evidence)
  }

  return followup
}

export function mergeFollowupIntoAssessments(
  plan: Plan,
  assessments: readonly VerifierStepAssessment[],
  followupEvidenceByStep: ReadonlyMap<string, readonly VerificationEvidence[]>
): VerifierStepAssessment[] {
  const followupSeedAssessments = assessments.map((assessment) => ({
    stepName: assessment.stepName,
    outcome: assessment.outcome,
    confidence: assessment.confidence,
    issues: [...(followupEvidenceByStep.get(assessment.stepName) ?? []).map((evidence) => evidence.message)],
    retryable: assessment.retryable
  }))
  const followupIssuesByStep = deriveIssuesFromEvidence(plan, followupSeedAssessments, followupEvidenceByStep)

  return assessments.map((assessment) => {
    const followupEvidence = followupEvidenceByStep.get(assessment.stepName) ?? []
    const followupIssues = followupIssuesByStep.get(assessment.stepName) ?? []
    if (followupEvidence.length === 0 && followupIssues.length === 0) return assessment
    return {
      ...assessment,
      confidence: Math.max(assessment.confidence, followupEvidence.length > 0 ? 0.72 : assessment.confidence),
      issues: uniqueStrings([...assessment.issues, ...followupEvidence.map((evidence) => evidence.message)]),
      evidence: uniqueStrings([
        ...(assessment.evidence ?? []).map((evidence) => evidence.id),
        ...followupEvidence.map((evidence) => evidence.id)
      ]).map(
        (id) => [...(assessment.evidence ?? []), ...followupEvidence].find((evidence) => evidence.id === id)!
      ),
      issueDetails: [...(assessment.issueDetails ?? []), ...followupIssues]
    }
  })
}
