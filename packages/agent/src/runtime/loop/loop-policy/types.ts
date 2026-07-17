/**
 * Loop policy — shared context for per-turn steering.
 *
 * One mental model, two phases:
 *   prepareTurn        — before the LLM call (reshape the action space)
 *   guardCompletion    — when the model returns zero tool calls (veto finish)
 *
 * @module
 */

import type { AgentConfig, Message, Tool } from "../../../domain/models/agent-types.js"
import type { AgentLoopState } from "../state.js"

/** Snapshot of loop state for policy rules. Rules may mutate `state` one-shot flags. */
export interface LoopPolicyContext {
  readonly iteration: number
  readonly userGoal: string
  readonly messages: readonly Message[]
  readonly state: AgentLoopState
  readonly toolList: readonly Tool[]
  readonly availableToolNames: readonly string[]
  /** Set when evaluating completion — the model's no-tool-call response. */
  readonly response?: { content: string | null; toolCalls: readonly unknown[] }
  readonly config?: {
    maxIterations: number
    enablePlanner: boolean
    plannerDelegateFn: AgentConfig["plannerDelegateFn"]
    completionValidator: AgentConfig["completionValidator"]
    enableAnswerStabilityGuard?: boolean
    verbose: boolean
  }
  readonly onPlannerTrace?: AgentConfig["onPlannerTrace"]
}

/** Result of prepareTurn — how to shape the upcoming LLM call. */
export interface TurnPrep {
  /** Winning rule name for trace/debug, or null when no rule applies. */
  readonly rule: string | null
  /** Tool names exposed to the LLM this turn (may be a subset). */
  readonly allowedToolNames: readonly string[]
  /** Optional transient system hint injected before the LLM call. */
  readonly hint: string | null
}

/** Completion was blocked — inject message and continue the loop. */
export interface CompletionBlock {
  readonly tag: string
  readonly message: string
  /** When set, return immediately as the final answer. */
  readonly finalAnswer?: string
}

export type TurnStartRule = (ctx: LoopPolicyContext) => TurnPrep | null
export type CompletionRule = (ctx: LoopPolicyContext) => CompletionBlock | null
export type CompletionRuleAsync = (ctx: LoopPolicyContext) => Promise<CompletionBlock | null>
