/**
 * Planner decision — assess whether a task needs structured planning.
 *
 * Inspired by agenc-core's assessPlannerDecision(), this scores a user request
 * on complexity signals and routes it to either:
 *   - Direct tool loop (simple tasks, score < 3)
 *   - Planner path (complex tasks, score >= 3)
 *
 * @module
 */

import type { Message } from "../types.js"
import type { PlannerDecision } from "./types.js"

// ============================================================================
// Signal detection patterns
// ============================================================================

/** Multi-step work: "build X then Y", "first...then...", numbered lists */
const MULTI_STEP_RE =
  /\b(?:first|then|next|after that|step \d|phase \d|\d+\.\s|\bfinally\b)/i

/** Tool diversity: mentions different tool categories */
const TOOL_DIVERSITY_RE =
  /\b(?:create|write|build|implement|test|verify|check|run|deploy|configure|install)\b/i

/** Delegation cue: multiple independent components, parallel work */
const DELEGATION_RE =
  /\b(?:multiple|several|all|each|every|parallel|concurrent|both|components?|modules?|features?|pages?|sections?)\b.*\b(?:create|build|implement|write|develop|add)\b/i

/** Implementation scope: large-scale creation request */
const IMPLEMENTATION_SCOPE_RE =
  /\b(?:build|create|implement|develop|make|write)\b[\s\S]{0,100}\b(?:app(?:lication)?|game|website|site|project|system|platform|service|api|dashboard|tool|library|framework|clone|full|complete|entire|whole)\b/i

/** Verification cue: request mentions testing/verification */
const VERIFICATION_RE =
  /\b(?:test|verify|ensure|check|validate|confirm|working|functional|playable|interactive)\b/i

/** Simple dialogue: just a question or greeting */
const SIMPLE_DIALOGUE_RE =
  /^(?:hi|hello|hey|thanks?|thank you|what is|how do|can you explain|tell me about)\b/i

/** Review/analysis question: not implementation, just looking at things */
const REVIEW_QUESTION_RE =
  /\b(?:read\s+through|review|analyze|check|look\s+at|go\s+through|evaluate|assess)\b[\s\S]{0,60}\?/i

// ============================================================================
// Structured signal collection
// ============================================================================

interface RequestSignals {
  readonly normalized: string
  readonly hasMultiStepCue: boolean
  readonly hasToolDiversityCue: boolean
  readonly hasDelegationCue: boolean
  readonly hasImplementationScopeCue: boolean
  readonly hasVerificationCue: boolean
  readonly longTask: boolean
  readonly structuredBulletCount: number
  readonly priorToolMessages: number
}

function collectSignals(messageText: string, history: readonly Message[]): RequestSignals {
  const normalized = messageText.trim()
  const bulletCount = (normalized.match(/^[\s]*[-*•]\s/gm) ?? []).length
    + (normalized.match(/^\s*\d+[.)]\s/gm) ?? []).length

  const priorToolMessages = history.filter(m => m.role === "tool").length

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
  }
}

// ============================================================================
// Main decision function
// ============================================================================

/**
 * Assess whether the given user message warrants structured planning.
 *
 * Scoring:
 *   - Multi-step cues: +3
 *   - Tool diversity cues: +1
 *   - Delegation cues: +4
 *   - Implementation scope cues: +3
 *   - Long/structured task: +1
 *   - Prior tool activity (>=4 prior tools): +2
 *
 * Score >= 3 → shouldPlan = true
 */
export function assessPlannerDecision(
  messageText: string,
  history: readonly Message[],
): PlannerDecision {
  const signals = collectSignals(messageText, history)
  let score = 0
  const reasons: string[] = []

  if (signals.hasMultiStepCue) {
    score += 3
    reasons.push("multi_step_cues")
  }
  if (signals.hasToolDiversityCue) {
    score += 1
    reasons.push("tool_diversity")
  }
  if (signals.hasDelegationCue) {
    score += 4
    reasons.push("delegation_cue")
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

  // Fast-exit: simple dialogue, review questions, or very short messages
  if (SIMPLE_DIALOGUE_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "simple_dialogue" }
  }
  if (REVIEW_QUESTION_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "review_question" }
  }
  if (signals.normalized.length < 20) {
    return { score, shouldPlan: false, reason: "too_short" }
  }

  const shouldPlan = score >= 3
  return {
    score,
    shouldPlan,
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
  }
}
