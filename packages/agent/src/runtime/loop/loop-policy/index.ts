/**
 * Loop policy — unified per-turn steering for the agent tool loop.
 *
 *   prepareTurn(ctx)      → reshape tools + optional hint before LLM call
 *   guardCompletion(ctx)  → block finish when the model returns no tool calls
 *
 * @module
 */

export type {
  CompletionBlock,
  CompletionRule,
  CompletionRuleAsync,
  LoopPolicyContext,
  TurnPrep,
  TurnStartRule
} from "./types.js"

export { computeAnswerSignature, checkAnswerStability } from "./answer-stability.js"
export type { AnswerSignature } from "./answer-stability.js"
export { completionContext, guardCompletion, turnStartContext } from "./completion.js"
export { prepareTurn } from "./turn-start.js"

// ── Backward-compatible aliases (pre-unification names) ──

export type { CompletionBlock as CompletionGuardResult } from "./types.js"
export type { LoopPolicyContext as CompletionGuardContext } from "./types.js"

import { guardCompletion } from "./completion.js"

/** @deprecated Use `guardCompletion`. */
export const runCompletionGuards = guardCompletion
