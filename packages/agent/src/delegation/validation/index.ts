import { StepRole } from "@mia/agent"
/**
 * Delegation output contract validation — structured evidence-based checks.
 *
 * Deterministic, code-level validation of child agent outputs BEFORE the LLM
 * verifier runs. Cross-references tool calls, file paths, acceptance criteria,
 * and completion claims.
 *
 * The validator is a pipeline of small "gate" functions; each returns either
 * a failure or null (meaning "continue"). Gates live in
 * delegation-validation/<group>.ts.
 *
 * Pattern/evidence helpers are in delegation-validation-patterns.ts.
 * Correction guidance is in delegation-validation-correction.ts.
 *
 * @module
 */

import {
    gateBlockedPhase,
    gatePresence,
    gateUnresolvedHandoff,
} from "./gates-presence.js"
import {
    gateFileMutation,
    gateRequiredSourceEvidence,
    gateSuccessfulTool,
    gateWorkspaceInspection,
} from "./gates-tools.js"
import {
    gateBrowserEvidence,
    gateFileArtifactEvidence,
    gateTargetCoverage,
} from "./gates-coverage.js"
import {
    gateAcceptanceCriteria,
    gateContradictoryCompletion,
    gateExecutableVerification,
} from "./gates-completion.js"
import type {
    DelegationContractSpec,
    DelegationOutputValidationCode,
    DelegationOutputValidationResult,
    GateParams,
} from "./types.js"
import type { ToolCallRecord } from "../../tools/_helpers/index.js"

// ── Public re-exports (preserve original public API) ─────────────

export {
    DELEGATION_OUTPUT_VALIDATION_CODES,
    type DelegationContractSpec,
    type DelegationOutputValidationCode,
    type DelegationOutputValidationResult,
} from "./types.js"

export { getCorrectionGuidance } from "../correct-validation.js"
export {
    classifyTaskIntent,
    extractAcceptanceTokens,
    isFileMutationToolCall,
    isLowSignalBrowserToolCall,
    isWorkspaceInspectionToolCall,
    specRequiresBrowserEvidence,
    specRequiresFileMutationEvidence,
    specRequiresSuccessfulToolEvidence,
    specRequiresWorkspaceInspection,
    type TaskIntent,
} from "../validation-patterns/index.js"

export {
    buildSemanticToolCallKey,
    didToolCallFail,
    extractToolFailureText,
    parseToolResultObject,
    type ToolCallRecord,
} from "../../tools/_helpers/index.js"

export { computeQualityProxy } from "../../governance/index.js"
export type { QualityProxyInput } from "../../governance/index.js"

// ── Master validation orchestrator ───────────────────────────────

/**
 * Run all validation gates in sequence. Returns the first failing gate's
 * result, or `{ ok: true }` if every gate passed.
 *
 * Gate order matters: cheap checks first, expensive coverage analysis last.
 */
export function validateDelegatedOutputContract(params: {
  spec: DelegationContractSpec
  output: string
  toolCalls?: readonly ToolCallRecord[]
}): DelegationOutputValidationResult {
  const { spec, output, toolCalls = [] } = params
  const trimmed = output.trim()
  const gateParams: GateParams = {
    spec,
    output,
    trimmed,
    outputLower: trimmed.toLowerCase(),
    toolCalls,
  }

  // Order matches the original numbering. Gate 10 was retired earlier.
  const gates = [
    gatePresence,             // 1-2: empty output / empty payload
    gateBlockedPhase,         // 3:   blocked phase output
    gateUnresolvedHandoff,    // 3b:  unresolved handoff language
    gateSuccessfulTool,       // 4:   all-tools-failed / no tool calls
    gateFileMutation,         // 5:   file mutation evidence
    gateWorkspaceInspection,  // 6:   workspace inspection evidence
    gateRequiredSourceEvidence, // 7: required-source-artifact reads
    gateFileArtifactEvidence, // 8:   file artifact mentioned
    gateTargetCoverage,       // 8b:  target coverage + reference integrity
    gateBrowserEvidence,      // 9:   browser evidence quality
    gateContradictoryCompletion, // 11: claim vs unresolved work
    gateExecutableVerification,  // 12: executable verification evidence
    gateAcceptanceCriteria,      // 13: acceptance-criteria token coverage
  ] as const

  for (const gate of gates) {
    const result = gate(gateParams)
    if (result) return result
  }
  return { ok: true }
}

// ── Convenience: build spec from SubagentTaskStep + ExecutionEnvelope ──

export function buildContractSpec(
  step: { objective: string; acceptanceCriteria: readonly string[]; requiredToolCapabilities: readonly string[] },
  envelope: { targetArtifacts: readonly string[]; requiredSourceArtifacts: readonly string[]; allowedTools: readonly string[]; effectClass: string; verificationMode: string; role?: string },
  lastValidationCode?: DelegationOutputValidationCode,
  knownProjectArtifacts?: readonly string[],
): DelegationContractSpec {
  return {
    task: step.objective,
    acceptanceCriteria: step.acceptanceCriteria,
    targetArtifacts: envelope.targetArtifacts,
    requiredSourceArtifacts: envelope.requiredSourceArtifacts,
    tools: [
      ...envelope.allowedTools,
      ...step.requiredToolCapabilities,
    ],
    effectClass: envelope.effectClass as DelegationContractSpec["effectClass"],
    verificationMode: envelope.verificationMode,
    role: (envelope.role ?? StepRole.Writer) as DelegationContractSpec["role"],
    lastValidationCode,
    knownProjectArtifacts,
  }
}
