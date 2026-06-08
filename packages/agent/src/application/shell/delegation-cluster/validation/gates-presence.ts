/**
 * Gates 1-3: presence checks (empty, blocked phase, unresolved handoff).
 *
 * @module
 */

import { DelegationOutputValidationCode } from "../../../../domain/enums/delegation.js"
import {
  BLOCKED_PHASE_RE,
  classifyTaskIntent,
  COMPLETION_CLAIM_RE,
  EMPTY_VALUES,
  specRequiresFileMutationEvidence,
  UNRESOLVED_HANDOFF_RE
} from "../validation-patterns/index.js"
import type { DelegationOutputValidationResult, GateParams } from "./types.js"

export function gatePresence(p: GateParams): DelegationOutputValidationResult | null {
  const { trimmed } = p
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: DelegationOutputValidationCode.EmptyOutput,
      message: "Child agent produced no output"
    }
  }
  if (EMPTY_VALUES.has(trimmed)) {
    return {
      ok: false,
      code: DelegationOutputValidationCode.EmptyStructuredPayload,
      message: `Child output is empty value: ${trimmed}`
    }
  }
  return null
}

export function gateBlockedPhase(p: GateParams): DelegationOutputValidationResult | null {
  const { trimmed, outputLower } = p
  if (BLOCKED_PHASE_RE.test(outputLower) && !COMPLETION_CLAIM_RE.test(outputLower)) {
    const blockMatchCount = [...outputLower.matchAll(new RegExp(BLOCKED_PHASE_RE.source, "gi"))].length
    const lines = trimmed.split("\n").length
    if (blockMatchCount >= 2 && lines < 10) {
      const firstMatch = outputLower.match(BLOCKED_PHASE_RE)
      return {
        ok: false,
        code: DelegationOutputValidationCode.BlockedPhaseOutput,
        message: `Child agent reported blocked/incomplete state: "${firstMatch?.[0]}"`
      }
    }
  }
  return null
}

export function gateUnresolvedHandoff(p: GateParams): DelegationOutputValidationResult | null {
  const { spec, trimmed } = p
  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (isImplementationLike && specRequiresFileMutationEvidence(spec) && UNRESOLVED_HANDOFF_RE.test(trimmed)) {
    const handoffMatch = trimmed.match(UNRESOLVED_HANDOFF_RE)
    return {
      ok: false,
      code: DelegationOutputValidationCode.UnresolvedHandoffOutput,
      message: `Output contains unresolved handoff/partial language: "${handoffMatch?.[0]}"`
    }
  }
  return null
}
