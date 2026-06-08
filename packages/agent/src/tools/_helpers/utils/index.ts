/**
 * Tool execution helpers — public barrel.
 *
 * Splits live in tool-utils/<module>:
 *   permission.ts        — checkToolCallPermission, ToolCallAction
 *   argument-parsing.ts  — parseToolCallArguments, sanitizeToolCallArgumentsForReplay
 *   exec-with-timeout.ts — executeToolWithTimeout + transport-failure helpers
 *   stuck-detection.ts   — trackToolCallFailureState, checkToolLoopStuckDetection
 *
 * Plus the small enrichment + fallback-content helpers below.
 *
 * @module
 */

import type { ToolCallRecord } from "../result.js"
import { didToolCallFail } from "../result.js"

// Re-export normalizeToolExecutionOutput for backwards compatibility
export { normalizeToolExecutionOutput } from "../result.js"

// ── Permissions ─────────────────────────────────────────────────
export { checkToolCallPermission } from "./permission.js"
export type { ToolCallAction, ToolCallPermissionResult } from "./permission.js"

// ── Argument parsing ────────────────────────────────────────────
export {
  MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS,
  parseToolCallArguments,
  sanitizeToolCallArgumentsForReplay
} from "./argument-parsing.js"
export type { ParseToolCallArgsResult } from "./argument-parsing.js"

// ── Tool execution + retry classification ───────────────────────
export {
  executeToolWithTimeout,
  isHighRiskToolCall,
  isLikelyTransportFailure,
  isToolRetrySafe
} from "./exec-with-timeout.js"
export type { ToolExecutionConfig, ToolExecutionResult } from "./exec-with-timeout.js"

// ── Stuck-loop detection ────────────────────────────────────────
export { checkToolLoopStuckDetection, trackToolCallFailureState } from "./stuck-detection.js"
export type { RoundStuckState, StuckDetectionResult, ToolLoopState } from "./stuck-detection.js"

// ── Progress summary + budget extension (re-exports) ────────────
export { evaluateToolRoundBudgetExtension, summarizeToolRoundProgress } from "../progress.js"
export type { ToolRoundBudgetExtensionResult, ToolRoundProgressSummary } from "../progress.js"

// ── Enrichment helpers (kept here — small + tightly bound to tool-result) ──

/**
 * Enrich a JSON tool result with additional metadata fields.
 */
export function enrichToolResultMetadata(result: string, metadata: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result
    return JSON.stringify({ ...(parsed as Record<string, unknown>), ...metadata })
  } catch {
    return result
  }
}

/**
 * Generate a fallback final content from tool call records when the LLM
 * produced no final response text.
 */
export function generateFallbackContent(toolCalls: readonly ToolCallRecord[]): string | undefined {
  if (toolCalls.length === 0) return undefined
  const lastSuccessful = [...toolCalls].reverse().find((c) => !didToolCallFail(c.isError, c.result))
  if (lastSuccessful) {
    return `Task completed. Last successful tool call: ${lastSuccessful.name}`
  }
  return "Task attempted but all tool calls failed. See tool results for details."
}
