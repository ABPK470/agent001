/**
 * Planner routing — first principles.
 *
 *   direct  — agent tool loop handles the goal (default)
 *   planner — structured decomposition + child agents
 *
 * Planner runs only when the task genuinely needs coordinated multi-step
 * work. Everything else uses the direct loop.
 *
 * @module
 */

import type { Message } from "../../types.js"
import { goalContainsDomainKeyword } from "../../../domain/tenant/known-vocabulary.js"
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
  COORDINATION_HEAVY_RE,
  MULTI_TARGET_CUE_RE,
  PLAN_CREATION_RE,
  REVIEW_QUESTION_RE,
  RUN_HISTORY_QUERY_RE,
  SIMPLE_DIALOGUE_RE,
  SIMPLE_FUNCTION_WRITE_RE,
  TOP_N_DATA_LIST_RE
} from "../internal/decision-patterns.js"
import type { PlannerDecision } from "../types.js"
import type { RequestSignals } from "./signals.js"
import { collectSignals, computePlannerScore } from "./signals.js"

function direct(reason: string, score = 0): PlannerDecision {
  return { route: "direct", reason, shouldPlan: false, score }
}

function planner(reason: string, score: number): PlannerDecision {
  return { route: "planner", reason, shouldPlan: true, score }
}

/**
 * Decide whether a goal needs structured planning or the direct tool loop.
 */
export function assessPlannerDecision(messageText: string, history: readonly Message[]): PlannerDecision {
  const signals = collectSignals(messageText, history)
  const n = signals.normalized
  const { score, reasons } = computePlannerScore(signals)

  // ── Direct (definitive) ───────────────────────────────────────
  if (SIMPLE_DIALOGUE_RE.test(n)) return direct("simple_dialogue", score)
  if (REVIEW_QUESTION_RE.test(n)) return direct("review_question", score)
  if (n.length < 20) return direct("too_short", score)
  if (EXACT_RESPONSE_RE.test(n) && !EXPLICIT_ENV_ACTION_RE.test(n)) {
    return direct("exact_response_turn", score)
  }
  if (DIALOGUE_MEMORY_RE.test(n) && !EXPLICIT_ENV_ACTION_RE.test(n)) {
    return direct("dialogue_memory_turn", score)
  }
  if (
    DIALOGUE_RECALL_RE.test(n) &&
    DIALOGUE_RECALL_REFERENCE_RE.test(n) &&
    !EXPLICIT_ENV_ACTION_RE.test(n)
  ) {
    return direct("dialogue_recall_turn", score)
  }
  if (EDIT_ARTIFACT_RE.test(n) && !signals.hasDelegationCue) return direct("edit_artifact", score)
  if (
    SIMPLE_FUNCTION_WRITE_RE.test(n) &&
    !signals.hasDelegationCue &&
    !signals.hasMultiStepCue &&
    !EXTERNAL_SERVICE_RE.test(n) &&
    !EXISTING_CODE_COUPLING_RE.test(n)
  ) {
    return direct("simple_function_write", score)
  }
  if (PLAN_CREATION_RE.test(n) && !signals.hasDelegationCue) return direct("plan_generation", score)
  if (
    DB_INVESTIGATION_RE.test(n) &&
    !signals.hasDelegationCue &&
    !signals.hasImplementationScopeCue
  ) {
    return direct("db_investigation", score)
  }
  if (DATA_FETCH_PIPELINE_RE.test(n) && !signals.hasDelegationCue) {
    return direct("data_fetch_pipeline", score)
  }
  if (
    RUN_HISTORY_QUERY_RE.test(n) &&
    !signals.hasDelegationCue &&
    !signals.hasImplementationScopeCue
  ) {
    return direct("run_history_query", score)
  }
  if (
    CONVERSATIONAL_DATA_QUERY_RE.test(n) &&
    !signals.hasDelegationCue &&
    !signals.hasImplementationScopeCue
  ) {
    return direct("conversational_data_query", score)
  }
  if (
    TOP_N_DATA_LIST_RE.test(n) &&
    !signals.hasDelegationCue &&
    !signals.hasImplementationScopeCue
  ) {
    return direct("top_n_data_list", score)
  }
  if (
    goalContainsDomainKeyword(n) &&
    !signals.hasDelegationCue &&
    !signals.hasImplementationScopeCue &&
    !EXISTING_CODE_COUPLING_RE.test(n)
  ) {
    return direct("domain_data_query", score)
  }

  // ── Planner (definitive) ──────────────────────────────────────
  if (signals.hasDelegationCue) return planner("delegation_cue", score)
  if (signals.hasMultiStepCue && signals.hasImplementationScopeCue) {
    return planner("multi_step_implementation", score)
  }
  if (signals.hasImplementationScopeCue && MULTI_TARGET_CUE_RE.test(n)) {
    return planner("multi_target", score)
  }
  if (signals.hasImplementationScopeCue && /\b\w+\s+page(?:,\s*(?:\w+\s+)?page)+\b/i.test(n)) {
    return planner("multi_page", score)
  }
  if (score >= 4 && needsPlannerCoordination(signals)) {
    return planner(reasons.join("+") || "high_complexity", score)
  }

  return direct("default", score)
}

function needsPlannerCoordination(signals: RequestSignals): boolean {
  return (
    signals.hasDelegationCue ||
    (signals.hasMultiStepCue && signals.hasImplementationScopeCue) ||
    signals.structuredBulletCount > 0 ||
    signals.targetFilePaths.length >= 2 ||
    COORDINATION_HEAVY_RE.test(signals.normalized) ||
    EXISTING_CODE_COUPLING_RE.test(signals.normalized)
  )
}
