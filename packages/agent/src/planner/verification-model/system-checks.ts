/**
 * System-level verifier checks — derived from per-step issue details to
 * surface cross-cutting failures (ownership ambiguity, integration drift).
 *
 * @module
 */

import type { VerifierDecision, VerifierSystemCheck } from "../types.js"
import { uniqueStrings } from "../verification-inference.js"

export function buildSystemChecks(decision: VerifierDecision): VerifierSystemCheck[] {
  const checks: VerifierSystemCheck[] = []
  const allIssues = decision.steps.flatMap((step) => step.issueDetails ?? [])

  const ambiguousIssues = allIssues.filter((issue) => issue.ownershipMode !== "deterministic_owner")
  if (ambiguousIssues.length > 0) {
    checks.push({
      code: "system_ownership_ambiguity",
      severity: ambiguousIssues.some((issue) => issue.severity === "fatal") ? "fatal" : "error",
      summary: `Multiple issues have ambiguous/shared ownership (${ambiguousIssues.length} issue(s)); repair convergence depends on coordination across suspected owners.`,
      confidence: Math.max(0.4, Math.min(0.9, ambiguousIssues.reduce((acc, issue) => acc + issue.confidence, 0) / ambiguousIssues.length)),
      affectedStepNames: uniqueStrings(ambiguousIssues.flatMap((issue) => issue.suspectedOwners)),
      affectedArtifacts: uniqueStrings(ambiguousIssues.flatMap((issue) => issue.affectedArtifacts)),
    })
  }

  const integrationArtifacts = allIssues.filter((issue) => issue.repairClass === "integration_wiring")
  if (integrationArtifacts.length > 1) {
    checks.push({
      code: "system_integration_drift",
      severity: "error",
      summary: `Cross-step integration invariants are failing across ${uniqueStrings(integrationArtifacts.flatMap((issue) => issue.affectedArtifacts)).length} artifact(s).`,
      confidence: 0.78,
      affectedStepNames: uniqueStrings(integrationArtifacts.flatMap((issue) => issue.suspectedOwners)),
      affectedArtifacts: uniqueStrings(integrationArtifacts.flatMap((issue) => issue.affectedArtifacts)),
    })
  }

  return checks
}
