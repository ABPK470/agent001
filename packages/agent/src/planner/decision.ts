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

import type { LLMClient, Message } from "../types.js"
import type { PlannerDecision, PlannerNeedLevel, RoutingConfidence } from "./types.js"

// ============================================================================
// Layer 1: Semantic hard-gate patterns
// ============================================================================

/** Multi-step work: "build X then Y", "first...then...", numbered lists */
const MULTI_STEP_RE =
  /\b(?:first|then|next|after that|step \d|phase \d|\d+\.\s|\bfinally\b)/i

/** Tool diversity: mentions different tool categories */
const TOOL_DIVERSITY_RE =
  /\b(?:create|write|build|implement|test|verify|check|run|deploy|configure|install)\b/i

/**
 * Delegation cue: multiple independent components or parallel work.
 * Uses [^.!?\n] to prevent cross-sentence false positives (e.g. "all project
 * files will be stored. Build a chess game" no longer fires).
 */
const DELEGATION_RE =
  // /\b(?:multiple|several|all|each|every|parallel|concurrent|both|components?|modules?|features?|pages?|sections?)\b[^.!?\n]{0,120}\b(?:create|build|implement|write|develop|add)\b/i
  /\b(sub[\s-]?agent|child agent|execute_with_agent|delegate|delegation|parallel(?:ize|ism)?|fanout)\b/i

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

/** Plan/document creation: user asks agent to write a plan, doc, or spec */
const PLAN_CREATION_RE =
  /\b(?:write|create|draft|make)\s+(?:a\s+)?(?:plan|spec|proposal|document|outline|summary|report|readme|changelog)\b/i

/**
 * Data-fetch pipeline: "query database → produce output".
 * Must go to the direct tool-loop so the agent can call query_mssql and
 * write_file with real data rather than generating a full server architecture.
 */
const DATA_FETCH_PIPELINE_RE =
  /\b(?:query|fetch|get|pull|retrieve|select|show|display|list|report\s+on|generate\s+(?:a\s+)?report)\b[\s\S]{0,80}\b(?:from\s+)?(?:database|db|mssql|sql\s+server|sql|table|data)\b|\b(?:mssql|sql\s+server|database|db)\b[\s\S]{0,80}\b(?:report|table|chart|display|html|dashboard|page|export|output|result)\b/i

/** High-throughput direct coding: single-artifact implementation in one file */
const SINGLE_ARTIFACT_BURST_RE =
  /\b(?:single|one|only)\s+(?:file|module|component|page|script)\b|\b(?:in|into)\s+[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/i

/** User explicitly asks for a full cohesive implementation pass */
const COHESIVE_IMPLEMENTATION_RE =
  /\b(?:full|complete|entire|end[- ]to[- ]end|from scratch|all logic|whole implementation)\b/i

/** Strong greenfield coherence cues */
const COHERENCE_FIRST_RE =
  /\b(?:playable|interactive|drag and drop|drag-and-drop|fully working|working end[- ]to[- ]end)\b/i

/** Concrete file targets */
const TARGET_FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|html|css|sql)\b/gi

/** Conflicting multi-target cues */
const MULTI_TARGET_CUE_RE =
  /\b(?:and|plus|along with|together with)\b[\s\S]{0,40}\b(?:file|module|component|page|script|api|service|backend|frontend|database|schema|tests?)\b/i

// ============================================================================
// Layer 2: Advisory heuristic patterns (signals, not decisions)
// ============================================================================

/** Bounded greenfield builds benefit from coherence before decomposition */
const BOUNDED_COHERENT_SCOPE_RE =
  /\b(?:build|create|implement|develop|make|write)\b[\s\S]{0,80}\b(?:app(?:lication)?|game|website|site|tool|dashboard|widget|prototype|project|starter|platform|system)\b/i

/** Larger greenfield system cues justify architecture freeze before decomposition */
const LARGE_GREENFIELD_BOOTSTRAP_RE =
  /\b(?:starter|platform|system|suite|workspace|tenant|billing|worker|backend|frontend|api|service|admin)\b/i

/**
 * Existing-code coupling tends to require planner coordination.
 * This is a HARD override: never route coupled work to bounded coherent gen.
 */
const EXISTING_CODE_COUPLING_RE =
  /\b(?:existing|current|already|integrat(?:e|ion)|hook\s+into|wire\s+into|refactor|migrat(?:e|ion)|extend|modify|update|patch|rename|repair)\b/i

/** Explicit coordination-heavy requests */
const COORDINATION_HEAVY_RE =
  /\b(?:multiple|several|coordinated|shared|cross[- ]file|cross[- ]module|across|between|independent)\b[\s\S]{0,40}\b(?:files?|modules?|components?|pages?|sections?|widgets?|panels?|interactions?)\b/i

/**
 * External service cues: signals that the task involves infrastructure beyond
 * simple filesystem writes. Used by the sanity override to scope it to truly
 * bounded builds.
 */
const EXTERNAL_SERVICE_RE =
  /\b(?:mssql|sql\s+server|postgres|mysql|mongo|redis|kafka|rabbitmq|deploy|kubernetes|docker\s+swarm|aws|azure|gcp|cloud\s+run|lambda|microservice|oauth|saml|stripe|twilio|sendgrid|broker|message\s+queue)\b/i

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
  if (signals.targetFilePaths.length !== 1) return false
  if (signals.hasDelegationCue || signals.hasMultiStepCue) return false
  if (signals.structuredBulletCount > 0) return false
  if (MULTI_TARGET_CUE_RE.test(signals.normalized)) return false
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

// ============================================================================
// Layer 3: Routing confidence scoring
// ============================================================================

/**
 * Score how confident the heuristic layer is about its routing recommendation.
 *
 * The confidence level controls whether Layer 4 (LLM routing) is invoked:
 * - "ambiguous" → escalate to LLM (signals are contradictory or weak)
 * - anything else → skip LLM router, heuristic is reliable enough
 *
 * Criteria:
 *   decisive_planner  — multi-step + delegation/bullets, OR coordinationNeed=high
 *   lean_planner      — medium coordination with at least one non-delegation
 *                       hard signal (multi-step, bullets, coupling, or
 *                       coordination_heavy pattern)
 *   ambiguous         — medium coordination came predominantly from DELEGATION_RE
 *                       alone with no supporting multi-step or structural signals;
 *                       regex fired but its semantic accuracy is uncertain
 *   lean_coherent     — low coordination + bounded implementation scope
 *   decisive_coherent — low coordination + strong coherence markers
 */
function computeRoutingConfidence(signals: RequestSignals, axes: RoutingAxes): RoutingConfidence {
  if (axes.coordinationNeed === "high") return "decisive_planner"
  if (signals.hasMultiStepCue && (signals.hasDelegationCue || signals.structuredBulletCount > 0)) return "decisive_planner"

  if (axes.coordinationNeed === "medium") {
    // At least one hard non-delegation coordination signal → lean planner
    if (signals.hasMultiStepCue) return "lean_planner"
    if (signals.structuredBulletCount > 0) return "lean_planner"
    if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return "lean_planner"
    if (COORDINATION_HEAVY_RE.test(signals.normalized)) return "lean_planner"
    // Coordination score is medium but only from DELEGATION_RE: ambiguous
    return "ambiguous"
  }

  // coordinationNeed === "low"
  if (COHESIVE_IMPLEMENTATION_RE.test(signals.normalized) || COHERENCE_FIRST_RE.test(signals.normalized)) {
    return "decisive_coherent"
  }
  if (signals.hasImplementationScopeCue && BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) {
    return "lean_coherent"
  }
  return "ambiguous"
}

// ============================================================================
// Layer 4: LLM-assisted routing (optional, async)
// ============================================================================

interface LLMRouterResult {
  coherence_need: PlannerNeedLevel
  coordination_need: PlannerNeedLevel
  reasoning: string
}

const LLM_ROUTER_SYSTEM = `You are a task routing classifier for an AI agent system.
Classify the following user task to determine the correct execution path.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "coherence_need": "low" | "medium" | "high",
  "coordination_need": "low" | "medium" | "high",
  "reasoning": "<one sentence>"
}

Definitions:
- coherence_need HIGH: the task is a single bounded deliverable that benefits from one cohesive generation pass (a game, an app, a tool, a widget, a dashboard, a single system).
- coordination_need HIGH: the task genuinely requires parallel or sequential INDEPENDENT work units with separate file ownership (e.g. multiple unrelated components, a multi-service architecture, an enumerated list of separate features).
- When in doubt, prefer coherence_need=high and coordination_need=low (simplicity default — attempt the whole thing in one coherent pass before over-committing to a plan).

Key distinctions:
- "all project files" in an organizational preamble ("Create a tmp dir where all files will be stored. Build a chess game") → coordination_need=low, the chess game is one bounded task.
- "multiple independent components" enumerated as separate deliverables → coordination_need=high.
- A single app/game/tool mentioning several features → coordination_need=low (features co-exist in one codebase).`

async function callLLMRouter(
  normalized: string,
  llm: LLMClient,
  signal?: AbortSignal,
): Promise<LLMRouterResult | null> {
  try {
    const response = await llm.chat(
      [
        { role: "system", content: LLM_ROUTER_SYSTEM },
        { role: "user", content: `Task:\n${normalized.slice(0, 1200)}` },
      ],
      [],
      { signal },
    )
    const raw = (response.content ?? "").trim()
    // Strip optional markdown code fences
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    if (
      typeof parsed.coherence_need === "string"
      && typeof parsed.coordination_need === "string"
      && ["low", "medium", "high"].includes(parsed.coherence_need)
      && ["low", "medium", "high"].includes(parsed.coordination_need)
    ) {
      return {
        coherence_need: parsed.coherence_need as PlannerNeedLevel,
        coordination_need: parsed.coordination_need as PlannerNeedLevel,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      }
    }
    return null
  } catch {
    return null
  }
}

// ============================================================================
// Layer 5: Sanity override + simplicity bias gates
// ============================================================================

/**
 * Sanity override: a clearly bounded single-system build with no external
 * service dependencies and no genuine coordination signals should never be
 * routed to the full planner.
 *
 * This implements the user-facing principle: if a task looks like a bounded
 * deliverable (game/app/tool/widget), has no external service dependencies,
 * involves no multi-step workflow, and shows no real ownership separation
 * (e.g. parallel ownership of different files by different logical agents),
 * prefer coherent single-pass generation. Avoid premature decomposition.
 *
 * Note: this is called AFTER shouldUseBoundedCoherentGeneration, so it only
 * fires for cases that gate missed (e.g. multiple explicit target files that
 * are still obviously a bounded single-system build).
 */
function isSanityOverrideBoundedBuild(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  // Hard blocks: these always need planning coordination
  if (EXTERNAL_SERVICE_RE.test(signals.normalized)) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
  if (LARGE_GREENFIELD_BOOTSTRAP_RE.test(signals.normalized)) return false
  if (signals.hasMultiStepCue) return false
  if (signals.structuredBulletCount > 0) return false
  if (axes.coordinationNeed === "high") return false
  if (signals.priorToolMessages >= 4) return false
  // Real ownership separation signals: genuinely parallel work units
  if (hasRealOwnershipSeparation(signals)) return false
  // When the user enumerates multiple explicit output files, they are signalling
  // file-by-file ownership — that coordination boundary should stay in the planner.
  if (signals.targetFilePaths.length > 1) return false
  return true
}

function shouldUseBoundedCoherentGeneration(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  if (axes.coordinationNeed !== "low") return false
  if (hasRealOwnershipSeparation(signals)) return false
  if (signals.priorToolMessages >= 4) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
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
  return !(signals.hasDelegationCue && signals.hasMultiStepCue)
}

// ============================================================================
// Main decision function
// ============================================================================

function makeDecision(
  route: import("./types.js").PlannerRoute,
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

  // ── Layer 1: Hard semantic gates ─────────────────────────────
  // These are definitive: a pattern match resolves the route with no further
  // analysis. Regex accuracy here is high (not advisory — truly decisive).
  if (SIMPLE_DIALOGUE_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "simple_dialogue", axes, "decisive_coherent", false)
  }
  if (REVIEW_QUESTION_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "review_question", axes, "decisive_coherent", false)
  }
  if (signals.normalized.length < 20) {
    return makeDecision("direct", score, "too_short", axes, "decisive_coherent", false)
  }
  if (EXACT_RESPONSE_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "exact_response_turn", axes, "decisive_coherent", false)
  }
  if (DIALOGUE_MEMORY_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "dialogue_memory_turn", axes, "decisive_coherent", false)
  }
  if (DIALOGUE_RECALL_RE.test(signals.normalized)) {
    return makeDecision("direct", score, "dialogue_recall_turn", axes, "decisive_coherent", false)
  }
  if (EDIT_ARTIFACT_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "edit_artifact_direct_path", axes, "decisive_coherent", false)
  }
  if (PLAN_CREATION_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "plan_generation_direct_path", axes, "decisive_coherent", false)
  }
  // Data-fetch pipelines use direct tool loop for real query results
  if (DATA_FETCH_PIPELINE_RE.test(signals.normalized) && !signals.hasDelegationCue) {
    return makeDecision("direct", score, "data_fetch_pipeline_direct_path", axes, "decisive_coherent", false)
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
    ? (effectiveAxes.coordinationNeed === "low" ? "lean_coherent" : "lean_planner")
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

  const shouldPlan = score >= 3
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
