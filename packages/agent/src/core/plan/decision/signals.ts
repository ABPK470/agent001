/**
 * Request signal collection for planner routing.
 *
 * @module
 */

import { MessageRole } from "../../domain/enums/message.js"
import type { Message } from "../../types.js"
import {
  COORDINATION_HEAVY_RE,
  DELEGATION_RE,
  EXISTING_CODE_COUPLING_RE,
  IMPLEMENTATION_SCOPE_RE,
  MULTI_STEP_RE,
  RECOVERY_HINT_RE,
  TARGET_FILE_RE,
  TOOL_DIVERSITY_RE,
  VERIFICATION_RE
} from "../internal/decision-patterns.js"

export interface RequestSignals {
  readonly normalized: string
  readonly hasMultiStepCue: boolean
  readonly hasToolDiversityCue: boolean
  readonly hasDelegationCue: boolean
  readonly hasImplementationScopeCue: boolean
  readonly hasVerificationCue: boolean
  readonly longTask: boolean
  readonly structuredBulletCount: number
  readonly priorToolMessages: number
  readonly targetFilePaths: readonly string[]
  readonly hasPriorNoProgressSignal: boolean
}

export function collectSignals(messageText: string, history: readonly Message[]): RequestSignals {
  const normalized = messageText.trim()
  const bulletCount =
    (normalized.match(/^[\s]*[-*•]\s/gm) ?? []).length + (normalized.match(/^\s*\d+[.)]\s/gm) ?? []).length

  const priorToolMessages = history.filter((m) => m.role === MessageRole.Tool).length
  const targetFilePaths = [
    ...new Set((normalized.match(TARGET_FILE_RE) ?? []).map((p) => p.replace(/^\.\//, "")))
  ]
  const historyTail = history.filter((m) => m.role !== MessageRole.System).slice(-4)
  const hasPriorNoProgressSignal = historyTail.some(
    (m) => typeof m.content === "string" && RECOVERY_HINT_RE.test(m.content)
  )

  return {
    normalized,
    hasMultiStepCue: MULTI_STEP_RE.test(normalized),
    hasToolDiversityCue: TOOL_DIVERSITY_RE.test(normalized),
    hasDelegationCue: DELEGATION_RE.test(normalized),
    hasImplementationScopeCue: IMPLEMENTATION_SCOPE_RE.test(normalized),
    hasVerificationCue: VERIFICATION_RE.test(normalized),
    longTask: normalized.length > 200 || bulletCount >= 3,
    structuredBulletCount: bulletCount,
    priorToolMessages,
    targetFilePaths,
    hasPriorNoProgressSignal
  }
}

/** Complexity score — planner when score >= 4 or explicit planner triggers fire. */
export function computePlannerScore(signals: RequestSignals): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  if (signals.hasMultiStepCue) {
    score += 3
    reasons.push("multi_step")
  }
  if (signals.hasToolDiversityCue) {
    score += 1
    reasons.push("tool_diversity")
  }
  if (signals.hasDelegationCue) {
    score += 4
    reasons.push("delegation")
  }
  if (signals.hasImplementationScopeCue) {
    score += 3
    reasons.push("implementation_scope")
  }
  if (signals.hasVerificationCue && signals.hasImplementationScopeCue) {
    score += 1
    reasons.push("verification_on_impl")
  }
  if (signals.longTask) {
    score += 1
    reasons.push("long_or_structured")
  }
  if (signals.priorToolMessages >= 4) {
    score += 2
    reasons.push("prior_tool_activity")
  }
  if (signals.hasPriorNoProgressSignal) {
    score += 2
    reasons.push("prior_no_progress")
  }
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) {
    score += 2
    reasons.push("existing_code_coupling")
  }
  if (COORDINATION_HEAVY_RE.test(signals.normalized)) {
    score += 2
    reasons.push("coordination_heavy")
  }

  return { score, reasons }
}
