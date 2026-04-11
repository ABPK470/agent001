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
import type { PlannerDecision, PlannerNeedLevel } from "./types.js"

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

// ── Direct-path gates (agenc-core pattern) ──────────────────────
// These detect request shapes that are better handled by a single agent
// without planner overhead, even if the complexity score is high.

/** Exact response: user wants a literal output, not an orchestrated build */
const EXACT_RESPONSE_RE =
  /\b(?:respond\s+with|output\s+exactly|just\s+(?:say|write|output|reply|return)|^(?:say|write|echo)\b)/i

/** Memory/recall: storing or retrieving info (no planning needed) */
const DIALOGUE_MEMORY_RE =
  /\b(?:remember|memorize|save\s+(?:this|that)|store\s+(?:this|that)|note\s+that|keep\s+in\s+mind)\b/i
const DIALOGUE_RECALL_RE =
  /\b(?:what\s+did\s+(?:I|you|we)|recall|do\s+you\s+remember|earlier\s+(?:I|you|we))\b/i

/** Edit artifact: simple read-edit-write cycle that one agent handles better */
const EDIT_ARTIFACT_RE =
  /\b(?:edit|update|change|modify|fix|patch|rename|refactor|replace)\b[\s\S]{0,80}\b(?:in|of|the\s+file|this\s+file|\.(?:ts|js|tsx|jsx|css|html|json|md|py|rs|go))\b/i

/** Plan/document creation: user asks agent to write a plan, doc, or spec (let LLM write directly) */
const PLAN_CREATION_RE =
  /\b(?:write|create|draft|make)\s+(?:a\s+)?(?:plan|spec|proposal|document|outline|summary|report|readme|changelog)\b/i

/**
 * High-throughput direct coding cue: user explicitly asks for single-artifact
 * implementation (one file/module/page) in a cohesive pass.
 */
const SINGLE_ARTIFACT_BURST_RE =
  /\b(?:single|one|only)\s+(?:file|module|component|page|script)\b|\b(?:in|into)\s+[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/i

/** User explicitly asks for a full cohesive implementation pass. */
const COHESIVE_IMPLEMENTATION_RE =
  /\b(?:full|complete|entire|end[- ]to[- ]end|from scratch|all logic|whole implementation)\b/i

/** Strong greenfield coherence cues even when the user does not say "from scratch" verbatim. */
const COHERENCE_FIRST_RE =
  /\b(?:playable|interactive|drag and drop|drag-and-drop|fully working|working end[- ]to[- ]end)\b/i

/** Concrete file targets used for high-confidence single-artifact routing. */
const TARGET_FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/gi

/** Conflicting multi-target cues that should block direct burst routing. */
const MULTI_TARGET_CUE_RE =
  /\b(?:and|plus|along with|together with)\b[\s\S]{0,40}\b(?:file|module|component|page|script|api|service|backend|frontend|database|schema|tests?)\b/i

/** Bounded greenfield builds benefit from coherence before decomposition. */
const BOUNDED_COHERENT_SCOPE_RE =
  /\b(?:build|create|implement|develop|make|write)\b[\s\S]{0,80}\b(?:app(?:lication)?|game|website|site|tool|dashboard|widget|prototype|project|starter|platform|system)\b/i

/** Larger greenfield system cues justify architecture freeze before decomposition. */
const LARGE_GREENFIELD_BOOTSTRAP_RE =
  /\b(?:starter|platform|system|suite|workspace|tenant|billing|worker|backend|frontend|api|service|admin)\b/i

/** Existing-code coupling tends to require planner coordination, not coherence-first direct work. */
const EXISTING_CODE_COUPLING_RE =
  /\b(?:existing|current|already|integrat(?:e|ion)|hook\s+into|wire\s+into|refactor|migrat(?:e|ion)|extend|modify|update|patch|rename|repair)\b/i

/** Explicit coordination-heavy requests should stay in planner land. */
const COORDINATION_HEAVY_RE =
  /\b(?:multiple|several|coordinated|shared|cross[- ]file|cross[- ]module|across|between|independent)\b[\s\S]{0,40}\b(?:files?|modules?|components?|pages?|sections?|widgets?|panels?|interactions?)\b/i

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
  readonly targetFilePaths: readonly string[]
}

interface RoutingAxes {
  readonly coherenceScore: number
  readonly coordinationScore: number
  readonly coherenceNeed: PlannerNeedLevel
  readonly coordinationNeed: PlannerNeedLevel
}

function collectSignals(messageText: string, history: readonly Message[]): RequestSignals {
  const normalized = messageText.trim()
  const bulletCount = (normalized.match(/^[\s]*[-*•]\s/gm) ?? []).length
    + (normalized.match(/^\s*\d+[.)]\s/gm) ?? []).length

  const priorToolMessages = history.filter(m => m.role === "tool").length
  const targetFilePaths = [...new Set((normalized.match(TARGET_FILE_RE) ?? []).map(p => p.replace(/^\.\//, "")))]

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
  }
}

function isHighConfidenceSingleArtifactBurst(signals: RequestSignals): boolean {
  const explicitSingleArtifact = /\b(?:single|one|only)\s+(?:file|module|component|page|script)\b/i.test(signals.normalized)
  if (!explicitSingleArtifact) return false

  // Require exactly one concrete target file path for deterministic routing.
  if (signals.targetFilePaths.length !== 1) return false

  // Block burst routing on ambiguous or decomposable requests.
  if (signals.hasDelegationCue || signals.hasMultiStepCue) return false
  if (signals.structuredBulletCount > 0) return false
  if (MULTI_TARGET_CUE_RE.test(signals.normalized)) return false

  // Must still be a cohesive implementation intent, not a tiny edit turn.
  return signals.hasImplementationScopeCue || COHESIVE_IMPLEMENTATION_RE.test(signals.normalized)
}

function toNeedLevel(score: number): PlannerNeedLevel {
  if (score >= 5) return "high"
  if (score >= 3) return "medium"
  return "low"
}

function hasRealOwnershipSeparation(signals: RequestSignals): boolean {
  return signals.hasMultiStepCue
    || signals.hasDelegationCue
    || signals.structuredBulletCount > 0
    || MULTI_TARGET_CUE_RE.test(signals.normalized)
    || COORDINATION_HEAVY_RE.test(signals.normalized)
}

function evaluateRoutingAxes(signals: RequestSignals): RoutingAxes {
  let coherenceScore = 0
  let coordinationScore = 0

  if (signals.hasImplementationScopeCue) coherenceScore += 3
  if (COHESIVE_IMPLEMENTATION_RE.test(signals.normalized)) coherenceScore += 2
  if (COHERENCE_FIRST_RE.test(signals.normalized)) coherenceScore += 2
  if (BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) coherenceScore += 1
  if (signals.longTask) coherenceScore += 1
  if (signals.targetFilePaths.length >= 2) coherenceScore += 1

  if (signals.hasMultiStepCue) coordinationScore += 3
  if (signals.hasDelegationCue) coordinationScore += 4
  if (signals.structuredBulletCount > 0) coordinationScore += 2
  if (signals.targetFilePaths.length >= 2) coordinationScore += 2
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) coordinationScore += 3
  if (COORDINATION_HEAVY_RE.test(signals.normalized)) coordinationScore += 3
  if (signals.priorToolMessages >= 4) coordinationScore += 1
  if (MULTI_TARGET_CUE_RE.test(signals.normalized)) coordinationScore += 1

  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) {
    coherenceScore = Math.max(0, coherenceScore - 1)
  }

  return {
    coherenceScore,
    coordinationScore,
    coherenceNeed: toNeedLevel(coherenceScore),
    coordinationNeed: toNeedLevel(coordinationScore),
  }
}

function shouldUseBoundedCoherentGeneration(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false

  // The key gate: if there is no coordination need, a single coherent agent pass
  // is always better than planner overhead — regardless of whether the user said
  // "fully" or "playable". Coordination need captures multi-step cues, delegation
  // cues, bullet lists, file-count cues, coupling, and explicit cross-module work.
  if (axes.coordinationNeed !== "low") return false
  if (hasRealOwnershipSeparation(signals)) return false
  if (signals.priorToolMessages >= 4) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false

  // If the user already anchors the request to many concrete artifact targets,
  // planner ownership often becomes more important than a single cohesive pass.
  if (signals.targetFilePaths.length > 1) return false

  return true
}

function shouldUsePlannerWithCoherentBootstrap(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  if (!LARGE_GREENFIELD_BOOTSTRAP_RE.test(signals.normalized) && signals.structuredBulletCount < 3 && signals.targetFilePaths.length < 3) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
  if (axes.coherenceNeed !== "high") return false
  if (axes.coordinationNeed === "low") return false

  // Freeze architecture first for larger greenfield work unless ownership
  // boundaries are already explicit enough to justify immediate decomposition.
  return !(signals.hasDelegationCue && signals.hasMultiStepCue)
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
 * Score >= 3 → shouldPlan = true unless a coherence-preserving direct route
 * is a better fit.
 */
export function assessPlannerDecision(
  messageText: string,
  history: readonly Message[],
): PlannerDecision {
  const signals = collectSignals(messageText, history)
  const axes = evaluateRoutingAxes(signals)
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

  // ── Direct-path gates (agenc-core pattern) ──────────────────────
  // Context-aware skips that bypass planning even when the score is high.
  // These detect request shapes handled better by a single agent without
  // planner decomposition overhead.
  if (SIMPLE_DIALOGUE_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "simple_dialogue", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (REVIEW_QUESTION_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "review_question", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (signals.normalized.length < 20) {
    return { score, shouldPlan: false, reason: "too_short", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (EXACT_RESPONSE_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "exact_response_turn", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (DIALOGUE_MEMORY_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "dialogue_memory_turn", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (DIALOGUE_RECALL_RE.test(signals.normalized)) {
    return { score, shouldPlan: false, reason: "dialogue_recall_turn", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (EDIT_ARTIFACT_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return { score, shouldPlan: false, reason: "edit_artifact_direct_path", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }
  if (PLAN_CREATION_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return { score, shouldPlan: false, reason: "plan_generation_direct_path", route: "direct", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }

  // Adaptive no-plan route: single-artifact implementation requests are usually
  // faster and higher quality in a direct cohesive coding pass than micro-planning.
  if (SINGLE_ARTIFACT_BURST_RE.test(signals.normalized) && isHighConfidenceSingleArtifactBurst(signals)) {
    return { score, shouldPlan: false, reason: "single_artifact_direct_burst", route: "single_artifact_direct_burst", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }

  // Bounded greenfield builds should preserve whole-solution coherence before
  // they are exposed to planner decomposition.
  if (shouldUseBoundedCoherentGeneration(signals, axes)) {
    return { score, shouldPlan: false, reason: "bounded_coherent_generation", route: "bounded_coherent_generation", coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed }
  }

  if (shouldUsePlannerWithCoherentBootstrap(signals, axes)) {
    return {
      score,
      shouldPlan: true,
      reason: "planner_with_coherent_bootstrap",
      route: "planner_with_coherent_bootstrap",
      coherenceNeed: axes.coherenceNeed,
      coordinationNeed: axes.coordinationNeed,
    }
  }

  const shouldPlan = score >= 3
  return {
    score,
    shouldPlan,
    route: shouldPlan ? "full_planner_decomposition" : "direct",
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
    coherenceNeed: axes.coherenceNeed,
    coordinationNeed: axes.coordinationNeed,
  }
}
