/**
 * Internal types for the tool-execution round helpers.
 *
 * @module
 */

import { canonicalizeRelative } from "../../../../internal/index.js"
import type { ToolCallRecord } from "../../../../tools/index.js"
import type { AgentConfig, Message, Tool } from "../../../../domain/agent-types.js"
import type { AgentLoopState } from "../state.js"

export const FILE_MUTATION_TOOLS = new Set(["write_file", "replace_in_file", "append_file"])

/** Min characters required to treat a write payload as "substantial" for the anti-paste check. */
export const ANTIPASTE_MIN_CONTENT_LEN = 400
/** Length of the needle extracted from a truncated query result. */
export const ANTIPASTE_NEEDLE_LEN = 120
/** How many recent truncated-query fingerprints to retain. */
export const MAX_TRUNCATED_FINGERPRINTS = 4

/** Normalize an artifact path the same way every guard / counter does. */
export function normalizeArtifactPath(path: string): string {
  return canonicalizeRelative(path).trim()
}

/** Result of executing all tool calls in one round. */
export interface ToolRoundResult {
  roundToolCalls: ToolCallRecord[]
  failuresThisRound: number
  delegationThisRound: boolean
  /**
   * True when the only delegation this round restricted the child to read-only
   * tools (analysis-only). Such delegations don't need post-hoc "verification"
   * via run_command/read_file — there's nothing to verify.
   */
  delegationThisRoundWasReadOnly: boolean
  forcedAbortRoundMessage: string | null
  forcedAbortLoopMessage: string | null
}

/** Context for tool execution. */
export interface ToolExecContext {
  tools: Map<string, Tool>
  toolList: Tool[]
  state: AgentLoopState
  messages: Message[]
  config: {
    signal: AgentConfig["signal"]
    toolKillManager: AgentConfig["toolKillManager"]
    onPlannerTrace?: AgentConfig["onPlannerTrace"]
    onToolResult?: AgentConfig["onToolResult"]
    verbose: boolean
  }
  iteration: number
  allToolCalls: ToolCallRecord[]
}
