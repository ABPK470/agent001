/**
 * Gates 11-13: completion claim consistency, executable verification evidence,
 * and acceptance-criteria token coverage.
 *
 * @module
 */

import {
    classifyTaskIntent,
    COMPLETION_CLAIM_RE,
    CONTEXT_SENSITIVE_MARKERS,
    extractAcceptanceTokens,
    hasPostMutationArtifactInspection,
    isExecutableVerificationToolCall,
    specRequiresFileMutationEvidence,
    UNRESOLVED_WORK_RE,
} from "../validation-patterns.js"
import type { DelegationOutputValidationResult, GateParams } from "./types.js"

export function gateContradictoryCompletion(p: GateParams): DelegationOutputValidationResult | null {
  const { trimmed, outputLower } = p
  if (!COMPLETION_CLAIM_RE.test(outputLower)) return null

  if (UNRESOLVED_WORK_RE.test(trimmed)) {
    const unresolvedMatch = trimmed.match(UNRESOLVED_WORK_RE)
    return {
      ok: false,
      code: "contradictory_completion_claim",
      message: `Child claims completion but output contains unresolved work: "${unresolvedMatch?.[0]}"`,
    }
  }
  for (const { re, label } of CONTEXT_SENSITIVE_MARKERS) {
    if (re.test(trimmed)) {
      return {
        ok: false,
        code: "contradictory_completion_claim",
        message: `Child claims completion but output contains unresolved work: "${label}"`,
      }
    }
  }
  return null
}

export function gateExecutableVerification(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, toolCalls } = p
  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (!isImplementationLike || !specRequiresFileMutationEvidence(spec) || toolCalls.length === 0) return null

  const hasVerificationCall = toolCalls.some(tc => !tc.isError && isExecutableVerificationToolCall(tc))
  const hasPostWriteInspection = hasPostMutationArtifactInspection(toolCalls, spec.targetArtifacts)
  if (hasVerificationCall || hasPostWriteInspection) return null

  return {
    ok: false,
    code: "missing_executable_verification_evidence",
    message: "Implementation output lacks executable verification evidence (runtime/test check or post-write artifact inspection)",
  }
}

export function gateAcceptanceCriteria(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, outputLower } = p
  if (spec.acceptanceCriteria.length === 0) return null

  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (isImplementationLike) return { ok: true } // implementation tasks evaluated by other gates

  const tokens = extractAcceptanceTokens(spec.acceptanceCriteria)
  if (tokens.length === 0) return null

  const matchedTokens = tokens.filter(t => outputLower.includes(t))
  const coverageRatio = matchedTokens.length / tokens.length
  if (coverageRatio < 0.1 && tokens.length >= 3) {
    return {
      ok: false,
      code: "acceptance_evidence_missing",
      message: `Only ${matchedTokens.length}/${tokens.length} acceptance criteria tokens found in output (coverage: ${(coverageRatio * 100).toFixed(0)}%)`,
    }
  }
  return null
}
