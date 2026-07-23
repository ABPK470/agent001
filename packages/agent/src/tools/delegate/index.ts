/**
 * Delegation context — shared shape for spawning child agents.
 *
 * The only remaining child-spawning path is the planner (see
 * `../delegate-spawn/spawn-for-plan.js`, built on the shared kernel in
 * `../delegate-spawn/spawn.js`). This module now holds just the pieces
 * that path depends on: the child worker system prompt and the context
 * type children are spawned with.
 *
 * @module
 */

import type { LLMClient, TokenUsage, Tool } from "../../domain/types/agent-types.js"
export { CHILD_SYSTEM_PROMPT } from "./child-prompt.js"

/**
 * Info passed to `DelegateContext.onChildIteration` on every iteration
 * boundary of every spawned child. Used by the orchestrator to publish
 * automatic Status messages to the bus on the child's behalf.
 */
export interface ChildIterationInfo {
  childRunId: string
  childAgentName: string
  iteration: number
  maxIterations: number
  /** First ~200 chars of the model's thinking content for this iteration, or null. */
  content: string | null
  /** Tool names the child intends to call this iteration (may be empty). */
  toolNames: string[]
}

export interface DelegateContext {
  /** LLM client shared across the delegation tree. */
  llm: LLMClient
  /** All tools available in the current run (already governed). */
  availableTools: Tool[]
  /** Current delegation depth (0 = top-level agent). */
  depth: number
  /** Maximum delegation depth. Default: 3 */
  maxDepth?: number
  /** Abort signal from the root run. */
  signal?: AbortSignal
  /** Called when child agent produces trace events for nesting. */
  onChildTrace?: (entry: Record<string, unknown>) => void
  /** Called when child agent completes a step (for token rollup). */
  onChildUsage?: (usage: TokenUsage, llmCalls: number) => void
  /** Extra tools to inject into every child (e.g., bus messaging tools). */
  extraChildTools?: Tool[]
  /**
   * Per-child tool factory. Preferred over `extraChildTools` when each
   * child needs tools bound to its OWN identity (e.g. bus tools that
   * should publish as `childAgentName` from `childRunId`, not as the
   * parent). When set, this is invoked once per spawned child and the
   * returned tools override any same-named entries from `extraChildTools`.
   */
  buildChildTools?: (childRunId: string, childAgentName: string) => Tool[]
  /**
   * Hook fired on every child iteration boundary (per `Agent.onThinking`).
   * The orchestrator uses this to auto-publish a `Status` bus message so
   * siblings, parent, and the UI BusFeed see liveness and progress
   * without relying on the model to remember to call a tool.
   *
   * Throttle policy is decided by the implementer (e.g. every Nth
   * iteration); the agent loop fires the hook every iteration.
   */
  onChildIteration?: (info: ChildIterationInfo) => void
  /** Optional: acquire a concurrency slot before running a child. */
  acquireSlot?: (childRunId: string) => Promise<() => void>
  /**
   * The fully-resolved system prompt of the parent agent (including DB knowledge,
   * environment context, discovery rules, and memory). Set by the orchestrator
   * after building systemMessages so that every child agent inherits the same
   * domain context. Without this, children are "blind" — they see only
   * CHILD_SYSTEM_PROMPT and have no knowledge of the database, schemas, or tools.
   */
  parentSystemPrompt?: string
}
