import { PlannerNeedLevel } from "@mia/agent"
/**
 * Planner decision — layered routing for agent tasks.
 *
 * Architecture (five layers, in order):
 *
 *   Layer 1 — Hard semantic gates (synchronous, definitive)
 *             Patterns that always resolve to a specific route regardless of
 *             complexity score: simple dialogue, data-fetch pipelines, edits,
 *             plan-creation, memory turns, etc.
 *
 *   Layer 2 — Heuristic signal collection (advisory only)
 *             Regex patterns and structural signals (multi-step cues, delegation
 *             cues, bullet counts, file paths) are collected here. They are
 *             WEAK SIGNALS, not decisions. A regex match is evidence, not a
 *             verdict. Every match increments a confidence score, nothing more.
 *
 *   Layer 3 — Routing confidence scoring
 *             Signals are aggregated into a RoutingConfidence level:
 *             decisive_planner → lean_planner → ambiguous → lean_coherent
 *             → decisive_coherent. Only when confidence is "ambiguous" does the
 *             router escalate to the LLM layer.
 *
 *   Layer 4 — LLM-assisted routing (async, optional)
 *             When confidence is "ambiguous" and an LLM client is available,
 *             a lightweight classification prompt is sent. The LLM understands
 *             sentence boundaries, intent, and context ("all project files" ≠
 *             "multiple independent tasks"). Its classification overrides the
 *             heuristic axes. Without an LLM, the heuristic fallback applies.
 *
 *   Layer 5 — Sanity override + simplicity bias (synchronous)
 *             Before committing to the planner, an explicit check asks: "is this
 *             clearly a bounded single-system build with no genuine coordination
 *             need?" If yes, force coherent generation regardless of any
 *             earlier heuristic fires. This prevents the chess-game class of
 *             misroutes. When still uncertain after LLM routing, the system
 *             defaults to coherent generation (simplicity default).
 *
 * @module
 */

import type { LLMClient, Message } from "../../types.js"
import {
    CONVERSATIONAL_DATA_QUERY_RE,
    DATA_FETCH_PIPELINE_RE,
    DB_INVESTIGATION_RE,
    DIALOGUE_MEMORY_RE,
    DIALOGUE_RECALL_RE,
    DIALOGUE_RECALL_REFERENCE_RE,
    EDIT_ARTIFACT_RE,
    EXACT_RESPONSE_RE,
    EXISTING_CODE_COUPLING_RE,
    EXPLICIT_ENV_ACTION_RE,
    EXTERNAL_SERVICE_RE,
    PLAN_CREATION_RE,
    REVIEW_QUESTION_RE,
    RUN_HISTORY_QUERY_RE,
    SIMPLE_DIALOGUE_RE,
    SIMPLE_FUNCTION_WRITE_RE,
    SINGLE_ARTIFACT_BURST_RE
} from "../internal/decision-patterns.js"
import type { PlannerDecision, PlannerRoute, RoutingConfidence } from "../types.js"
import {
    isSanityOverrideBoundedBuild,
    shouldUseBoundedCoherentGeneration,
    shouldUsePlannerWithCoherentBootstrap,
} from "./coherent-gates.js"
import { callLLMRouter } from "./llm-router.js"
import {
    type RoutingAxes,
    collectSignals,
    computeRoutingConfidence,
    evaluateRoutingAxes,
    isHighConfidenceSingleArtifactBurst,
} from "./signals.js"

// ============================================================================
// Main decision function
// ============================================================================

function makeDecision(
  route: PlannerRoute,
  score: number,
  reason: string,
  axes: RoutingAxes,
  routingConfidence: RoutingConfidence,
  llmClassified: boolean,
): PlannerDecision {
  const shouldPlan = route === "full_planner_decomposition" || route === "planner_with_coherent_bootstrap"
  return { score, shouldPlan, reason, route, coherenceNeed: axes.coherenceNeed, coordinationNeed: axes.coordinationNeed, routingConfidence, llmClassified }
}

/**
 * Assess whether the given user message warrants structured planning.
 *
 * Layers 1–5 as described in the module doc above. Pass an LLM client to
 * enable Layer 4 (LLM router) for ambiguous tasks.
 *
 * The function is async because Layer 4 may perform an LLM call in the
 * "ambiguous" confidence band. All other layers are synchronous.
 */
export async function assessPlannerDecision(
  messageText: string,
  history: readonly Message[],
  llm?: LLMClient,
  signal?: AbortSignal,
): Promise<PlannerDecision> {
  const signals = collectSignals(messageText, history)
  const axes = evaluateRoutingAxes(signals)
  let score = 0
  const reasons: string[] = []

  if (signals.hasMultiStepCue) { score += 3; reasons.push("multi_step_cues") }
  if (signals.hasToolDiversityCue) { score += 1; reasons.push("tool_diversity") }
  if (signals.hasDelegationCue) { score += 4; reasons.push("delegation_cue") }
  if (signals.hasImplementationScopeCue) { score += 3; reasons.push("implementation_scope") }
  if (signals.hasVerificationCue && signals.hasImplementationScopeCue) { score += 1; reasons.push("verification_on_impl") }
  if (signals.longTask) { score += 1; reasons.push("long_or_structured") }
  if (signals.priorToolMessages >= 4) { score += 2; reasons.push("prior_tool_activity") }
  if (signals.hasPriorNoProgressSignal) { score += 2; reasons.push("prior_no_progress") }

  // ── Layer 1: Hard semantic gates ─────────────────────────────
  // These are definitive: a pattern match resolves the route with no further
  // analysis. Regex accuracy here is high (not advisory — truly decisive).
  // Each dialogue gate is double-gated with EXPLICIT_ENV_ACTION_RE: if the
  // message says "remember X, now build Y", it is NOT a pure dialogue turn.
  if (SIMPLE_DIALOGUE_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "simple_dialogue", axes, "decisive_coherent", false)
  }
  if (REVIEW_QUESTION_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "review_question", axes, "decisive_coherent", false)
  }
  if (signals.normalized.length < 20) {
    return makeDecision("direct", score, "too_short", axes, "decisive_coherent", false)
  }
  if (EXACT_RESPONSE_RE.test(signals.normalized) && !EXPLICIT_ENV_ACTION_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "exact_response_turn", axes, "decisive_coherent", false)
  }
  if (DIALOGUE_MEMORY_RE.test(signals.normalized) && !EXPLICIT_ENV_ACTION_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "dialogue_memory_turn", axes, "decisive_coherent", false)
  }
  if (
    DIALOGUE_RECALL_RE.test(signals.normalized)
    && DIALOGUE_RECALL_REFERENCE_RE.test(signals.normalized)
    && !EXPLICIT_ENV_ACTION_RE.test(signals.normalized)
  ) {
    return makeDecision("direct", score, "dialogue_recall_turn", axes, "decisive_coherent", false)
  }
  if (EDIT_ARTIFACT_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "edit_artifact_direct_path", axes, "decisive_coherent", false)
  }
  // Single function/script write — no multi-step structure, no external deps, one concern.
  // The parent agent handles this inline; planner decomposition adds 30K+ token overhead.
  if (
    SIMPLE_FUNCTION_WRITE_RE.test(signals.normalized)
    && !signals.hasDelegationCue
    && !signals.hasMultiStepCue
    && !EXTERNAL_SERVICE_RE.test(signals.normalized)
    && !EXISTING_CODE_COUPLING_RE.test(signals.normalized)
  ) {
    return makeDecision("direct", score, "simple_function_write_direct_path", axes, "decisive_coherent", false)
  }
  if (PLAN_CREATION_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "plan_generation_direct_path", axes, "decisive_coherent", false)
  }
  // Database investigation tasks (identify views, find joins, analyze schema, etc.) are
  // pure tool-call work — they answer questions about an existing database, they never
  // produce code files. The planner would generate a nonsensical BLUEPRINT with
  // TypeScript function signatures inside .json data files. Route direct unconditionally.
  // Guard: skip if the goal is actually a software build mentioning DB concepts.
  if (DB_INVESTIGATION_RE.test(signals.normalized) && !signals.hasDelegationCue && !signals.hasImplementationScopeCue) {
    return makeDecision("direct", score, "db_investigation_direct_path", axes, "decisive_coherent", false)
  }
  // Data-fetch pipelines use direct tool loop for real query results
  if (DATA_FETCH_PIPELINE_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "data_fetch_pipeline_direct_path", axes, "decisive_coherent", false)
  }
  if (
    RUN_HISTORY_QUERY_RE.test(signals.normalized)
    && !signals.hasDelegationCue
    && !signals.hasImplementationScopeCue
  ) {
    return makeDecision("direct", score, "run_history_query_direct_path", axes, "decisive_coherent", false)
  }
  // Conversational data/metadata query: "are there any X created by Y", "which X was
  // modified by Z", etc. These are single-shot DB lookups — the planner cannot infer
  // correct tool names for them and will hallucinate step definitions. Route direct
  // unconditionally when the request has no delegation or implementation-scope intent.
  if (
    CONVERSATIONAL_DATA_QUERY_RE.test(signals.normalized)
    && !signals.hasDelegationCue
    && !signals.hasImplementationScopeCue
  ) {
    return makeDecision("direct", score, "conversational_data_query_direct_path", axes, "decisive_coherent", false)
  }
  // Single-artifact implementation burst
  if (SINGLE_ARTIFACT_BURST_RE.test(signals.normalized) && isHighConfidenceSingleArtifactBurst(signals)) {
    return makeDecision("single_artifact_direct_burst", score, "single_artifact_direct_burst", axes, "decisive_coherent", false)
  }

  // ── Layer 3: Heuristic confidence scoring ────────────────────
  const heuristicConfidence = computeRoutingConfidence(signals, axes)
  let effectiveAxes = axes
  let llmClassified = false

  // ── Layer 4: LLM-assisted routing (for ambiguous cases only) ─
  // Only invoked when confidence is "ambiguous" AND an LLM client is provided.
  // The LLM understands semantic intent better than any regex can.
  if (heuristicConfidence === "ambiguous" && llm != null) {
    const llmResult = await callLLMRouter(signals.normalized, llm, signal)
    if (llmResult != null) {
      effectiveAxes = {
        ...axes,
        coherenceNeed: llmResult.coherence_need,
        coordinationNeed: llmResult.coordination_need,
      }
      llmClassified = true
    }
  }

  const routingConfidence: RoutingConfidence = llmClassified
    ? (effectiveAxes.coordinationNeed === PlannerNeedLevel.Low ? "lean_coherent" : "lean_planner")
    : heuristicConfidence

  // ── Layer 5: Sanity override + coherence gates ───────────────
  // shouldUseBoundedCoherentGeneration is the primary coherence gate
  // (coordinationNeed must be "low").  isSanityOverrideBoundedBuild is a
  // secondary fallback that catches bounded builds with multiple explicit
  // target files but no real ownership-separation signals (e.g. a chess game
  // that explicitly lists 3 output files).  Both prevent over-planning of
  // self-contained deliverables — the "sanity override" pattern.
  if (shouldUseBoundedCoherentGeneration(signals, effectiveAxes)) {
    return makeDecision("bounded_coherent_generation", score, "bounded_coherent_generation", effectiveAxes, routingConfidence, llmClassified)
  }
  if (isSanityOverrideBoundedBuild(signals, effectiveAxes)) {
    return makeDecision("bounded_coherent_generation", score, "sanity_override_bounded_build", effectiveAxes, routingConfidence, llmClassified)
  }
  if (shouldUsePlannerWithCoherentBootstrap(signals, effectiveAxes)) {
    return makeDecision("planner_with_coherent_bootstrap", score, "planner_with_coherent_bootstrap", effectiveAxes, routingConfidence, llmClassified)
  }

  const shouldPlan = score >= 4
  return {
    score,
    shouldPlan,
    route: shouldPlan ? "full_planner_decomposition" : "direct",
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
    coherenceNeed: effectiveAxes.coherenceNeed,
    coordinationNeed: effectiveAxes.coordinationNeed,
    routingConfidence,
    llmClassified,
  }
}
