import { VerifierIssueSeverity } from "../../domain/index.js"
/**
 * Verification inference helpers — issue classification, severity, repair class,
 * ownership attribution, path extraction.
 *
 * Extracted from verification-model.ts for maintainability.
 *
 * @module
 */

import { compilePlannerRuntime } from "../runtime-model.js"
import type {
  Plan,
  SubagentTaskStep,
  VerificationEvidence,
  VerifierIssue,
  VerifierOwnershipMode,
  VerifierRepairClass
} from "../types.js"

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function normalizePath(value: string): string {
  return value.replace(/^\.\//, "")
}

export function extractPaths(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})/g) ?? []
  return uniqueStrings(matches.map(normalizePath))
}

export function inferIssueCode(summary: string): string {
  const contractMatch = summary.match(/^\[contract:(\w+)\]/)
  if (contractMatch?.[1]) return `contract_${contractMatch[1]}`
  if (/Cross-file signature mismatch/i.test(summary)) return "cross_file_signature_mismatch"
  if (/Import\/export mismatch/i.test(summary)) return "import_export_mismatch"
  if (/Integration gap/i.test(summary)) return "integration_gap"
  if (/Browser module mismatch/i.test(summary)) return "browser_module_mismatch"
  if (/Style integration gap/i.test(summary)) return "style_integration_gap"
  if (/SPEC FUNCTION MISMATCH/i.test(summary)) return "spec_function_mismatch"
  if (/SPEC STRUCTURE MISMATCH/i.test(summary)) return "spec_structure_mismatch"
  if (/SPEC MAPPING MISSING/i.test(summary)) return "spec_mapping_missing"
  if (/PATH MISMATCH/i.test(summary)) return "path_mismatch"
  if (/SCOPE VIOLATION/i.test(summary)) return "scope_violation"
  if (/Browser check/i.test(summary)) return "browser_check_failure"
  if (/Syntax error|Syntax validation failed/i.test(summary)) return "syntax_failure"
  if (/Placeholder|stub/i.test(summary)) return "placeholder_logic"
  if (/VERIFICATION MODALITY GAP|CRITERIA PROOF MISSING/i.test(summary)) return "verification_gap"
  if (/FUNCTION LOSS/i.test(summary)) return "function_loss"
  return (
    summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "verification_issue"
  )
}

export function inferSeverity(summary: string): VerifierIssueSeverity {
  if (/FUNCTION LOSS|contradictory_completion_claim|unresolved_handoff_output|fatal/i.test(summary))
    return VerifierIssueSeverity.Fatal
  if (/fail|error|mismatch|missing|violation|corrupted|gibberish|syntax|rejected/i.test(summary))
    return VerifierIssueSeverity.Error
  return VerifierIssueSeverity.Warning
}

export function inferRepairClass(summary: string): VerifierRepairClass {
  if (
    /Cross-file signature mismatch|Import\/export mismatch|Integration gap|Browser module mismatch|Style integration gap/i.test(
      summary
    )
  )
    return "integration_wiring"
  if (/Browser check|runtime|Uncaught Exceptions|Console Errors|Network Failures/i.test(summary))
    return "runtime_failure"
  if (/Syntax error|Syntax validation failed/i.test(summary)) return "syntax_failure"
  if (/Placeholder|stub|trivial return|returns constant/i.test(summary)) return "placeholder_logic"
  if (/PATH MISMATCH|SCOPE VIOLATION/i.test(summary)) return "path_scope"
  if (/SPEC FUNCTION MISMATCH|SPEC STRUCTURE MISMATCH|BLUEPRINT|contract/i.test(summary))
    return "contract_drift"
  if (/Integration gap|module mismatch|wiring|load|stylesheet rules/i.test(summary))
    return "integration_wiring"
  if (/VERIFICATION MODALITY GAP|CRITERIA PROOF MISSING/i.test(summary)) return "verification_gap"
  return "owner_implementation"
}

export function inferIssueConfidence(
  source: VerificationEvidence["source"],
  summary: string,
  ownershipMode: VerifierOwnershipMode,
  suspectedOwners: readonly string[]
): number {
  const sourceBase = source === "contract" ? 0.95 : source === "deterministic" ? 0.85 : 0.65
  const ambiguityPenalty =
    ownershipMode === "deterministic_owner"
      ? 0
      : ownershipMode === "shared_owners"
        ? 0.12
        : ownershipMode === "integration_layer"
          ? 0.18
          : ownershipMode === "planner_fault"
            ? 0.15
            : 0.22
  const ownerPenalty = suspectedOwners.length <= 1 ? 0 : Math.min(0.2, (suspectedOwners.length - 1) * 0.07)
  const wordingPenalty = /maybe|appears|likely|suggests|possible/i.test(summary) ? 0.08 : 0
  return Math.max(0.2, Math.min(0.99, sourceBase - ambiguityPenalty - ownerPenalty - wordingPenalty))
}

export function isDependencyGateIssue(issue: VerifierIssue): boolean {
  return (
    issue.code.startsWith("waiting_on_accepted_upstream_artifacts") ||
    /^Waiting on accepted upstream artifacts:/i.test(issue.summary)
  )
}

export function buildEvidenceId(
  stepName: string,
  source: VerificationEvidence["source"],
  index: number,
  code: string
): string {
  return `${stepName}:${source}:${index}:${code}`
}

export function getSubagentStep(plan: Plan, stepName: string): SubagentTaskStep | undefined {
  const step = plan.steps.find((candidate) => candidate.name === stepName)
  return step?.stepType === "subagent_task" ? (step as SubagentTaskStep) : undefined
}

export function isBlueprintLikeStep(step: SubagentTaskStep | undefined): boolean {
  if (!step) return false
  return (
    /blueprint/i.test(step.name) ||
    step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  )
}

export function inferAffectedArtifacts(step: SubagentTaskStep | undefined, summary: string): string[] {
  const extracted = extractPaths(summary)
  if (extracted.length > 0) return extracted
  return step?.executionContext.targetArtifacts.map(normalizePath) ?? []
}

export function inferSourceArtifacts(step: SubagentTaskStep | undefined, summary: string): string[] {
  const extracted = extractPaths(summary)
  const targetSet = new Set(step?.executionContext.targetArtifacts.map(normalizePath) ?? [])
  const sourceArtifacts = extracted.filter((path) => !targetSet.has(path))
  if (sourceArtifacts.length > 0) return sourceArtifacts
  return step?.executionContext.requiredSourceArtifacts.map(normalizePath) ?? []
}

export function deriveOwnershipAttribution(
  plan: Plan,
  source: VerificationEvidence["source"],
  assessmentStepName: string,
  affectedArtifacts: readonly string[],
  sourceArtifacts: readonly string[],
  summary: string
): {
  ownerStepName: string
  suspectedOwners: string[]
  primaryOwner?: string
  ownershipMode: VerifierOwnershipMode
  confidence: number
} {
  const runtime = compilePlannerRuntime(plan)
  const assessmentStep = getSubagentStep(plan, assessmentStepName)
  const candidateArtifacts = uniqueStrings([...affectedArtifacts, ...sourceArtifacts].map(normalizePath))
  const candidateOwners = uniqueStrings(
    candidateArtifacts
      .map((artifact) => runtime.ownershipGraph.get(artifact)?.ownerStepName ?? undefined)
      .filter((owner): owner is string => Boolean(owner))
  )

  const mentionsPlanner =
    /blueprint|plan|planner/i.test(summary) && /drift|missing|mapping|coverage|contract|weak/i.test(summary)
  const blueprintContractIssue = /^BLUEPRINT\b/i.test(summary)
  const isIntegration =
    /Cross-file signature mismatch|Import\/export mismatch|Integration gap|Browser module mismatch|Style integration gap/i.test(
      summary
    )

  let ownershipMode: VerifierOwnershipMode
  let suspectedOwners: string[]
  let primaryOwner: string | undefined

  if (blueprintContractIssue && isBlueprintLikeStep(assessmentStep)) {
    ownershipMode = "planner_fault"
    suspectedOwners = [assessmentStepName]
    primaryOwner = assessmentStepName
  } else if (mentionsPlanner) {
    ownershipMode = "planner_fault"
    suspectedOwners = uniqueStrings([assessmentStepName, ...candidateOwners])
    primaryOwner = candidateOwners[0] ?? assessmentStepName
  } else if (isIntegration && candidateOwners.length > 1) {
    ownershipMode = "integration_layer"
    suspectedOwners = candidateOwners
    primaryOwner = undefined
  } else if (candidateOwners.length > 1) {
    ownershipMode = "shared_owners"
    suspectedOwners = candidateOwners
    primaryOwner = candidateOwners[0]
  } else if (candidateOwners.length === 1) {
    ownershipMode = "deterministic_owner"
    suspectedOwners = candidateOwners
    primaryOwner = candidateOwners[0]
  } else {
    ownershipMode = isIntegration ? "integration_layer" : "ambiguous"
    suspectedOwners = [assessmentStepName]
    primaryOwner = assessmentStepName
  }

  const confidence = inferIssueConfidence(source, summary, ownershipMode, suspectedOwners)

  return {
    ownerStepName: primaryOwner ?? suspectedOwners[0] ?? assessmentStepName,
    suspectedOwners,
    primaryOwner,
    ownershipMode,
    confidence
  }
}
