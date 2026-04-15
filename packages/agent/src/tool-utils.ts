/**
 * Tool execution helpers — permission checking, argument parsing/repair,
 * tool execution with timeout racing & transport-failure retry,
 * stuck detection, and progress summary.
 *
 * Ported from agenc-core chat-executor-tool-utils.ts and chat-executor-tool-loop.ts,
 * adapted for agent001's type system.
 *
 * @module
 */

import {
    HIGH_RISK_TOOLS,
    MAX_CONSECUTIVE_ALL_FAILED_ROUNDS,
    MAX_CONSECUTIVE_IDENTICAL_FAILURES,
    MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS,
    MAX_TOOL_CALL_ARGUMENT_CHARS,
    SAFE_RETRY_TOOLS,
} from "./constants.js"
import type { ToolCallRecord } from "./tool-result.js"
import { buildSemanticToolCallKey, didToolCallFail, extractToolFailureText, normalizeToolExecutionOutput } from "./tool-result.js"
import type { ToolResultEnvelope } from "./types.js"

// Re-export normalizeToolExecutionOutput for backwards compatibility
export { normalizeToolExecutionOutput } from "./tool-result.js"

// ============================================================================
// Constants (local only — not duplicated from constants.ts)
// ============================================================================

/** Max chars of raw preview kept when tool-call args are truncated. */
export const MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS = 4_000

// ============================================================================
// Tool call permission
// ============================================================================

export type ToolCallAction = "processed" | "skip" | "end_round" | "abort_round" | "abort_loop"

export interface ToolCallPermissionResult {
  readonly action: ToolCallAction
  readonly errorResult?: string
}

/**
 * Check whether a tool call is permitted against the available tool set.
 */
export function checkToolCallPermission(
  toolName: string,
  availableTools: ReadonlySet<string>,
): ToolCallPermissionResult {
  if (!availableTools.has(toolName)) {
    return {
      action: "skip",
      errorResult: JSON.stringify({
        error: `Tool "${toolName}" is not available. Available: ${[...availableTools].join(", ")}`,
      }),
    }
  }
  return { action: "processed" }
}

// ============================================================================
// Argument parsing & repair
// ============================================================================

export type ParseToolCallArgsResult =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

/**
 * Parse and validate tool call JSON arguments.
 * Returns structured success/error so caller can feed error back to LLM.
 */
export function parseToolCallArguments(
  rawArguments: unknown,
): ParseToolCallArgsResult {
  if (typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)) {
    return { ok: true, args: rawArguments as Record<string, unknown> }
  }
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "Tool arguments must be a JSON object, not a primitive or array." }
      }
      return { ok: true, args: parsed as Record<string, unknown> }
    } catch (parseErr) {
      return {
        ok: false,
        error: `Invalid tool arguments: ${(parseErr as Error).message}. ` +
          "Break your work into smaller pieces if output was truncated.",
      }
    }
  }
  return { ok: false, error: "Tool arguments must be a JSON object." }
}

/**
 * Truncate oversized tool call arguments for replay in message history.
 */
export function sanitizeToolCallArgumentsForReplay(raw: string): string {
  if (raw.length <= MAX_TOOL_CALL_ARGUMENT_CHARS) return raw
  const preview = raw.slice(0, MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS) + "..."
  return JSON.stringify({
    __truncatedToolCallArgs: true,
    originalChars: raw.length,
    preview,
  })
}

// ============================================================================
// Tool execution with timeout racing & transport-failure retry
// ============================================================================

export interface ToolExecutionConfig {
  /** Timeout for a single tool call in ms. 0 = no timeout. */
  readonly toolCallTimeoutMs: number
  /** Max transport-failure retries. */
  readonly maxRetries: number
  /** AbortSignal for external cancellation. */
  readonly signal?: AbortSignal
}

export interface ToolExecutionResult {
  readonly result: string
  readonly isError: boolean
  readonly toolFailed: boolean
  readonly timedOut: boolean
  readonly retryCount: number
  readonly retrySuppressedReason?: string
  readonly durationMs: number
  readonly outcome?: ToolResultEnvelope
}

/**
 * Execute a tool call with timeout racing and transport-failure retry.
 *
 * - Timeout: races the tool execution against a configurable timeout.
 * - Transport retry: transient errors (timeout, network, connection refused)
 *   are retried for safe tools; high-risk tools only retry with idempotency key.
 * - Semantic failures are never retried.
 */
export async function executeToolWithTimeout(
  toolName: string,
  args: Record<string, unknown>,
  execute: (a: Record<string, unknown>) => Promise<string | ToolResultEnvelope>,
  config: ToolExecutionConfig,
): Promise<ToolExecutionResult> {
  const toolStart = Date.now()
  let result = JSON.stringify({ error: "Tool execution failed" })
  let isError = false
  let toolFailed = false
  let timedOut = false
  let retrySuppressedReason: string | undefined
  let retryCount = 0
  let outcome: ToolResultEnvelope | undefined

  const maxRetries = Math.max(0, config.maxRetries)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    const toolCallPromise = (async (): Promise<{
      result: string; isError: boolean; timedOut: boolean; threw: boolean; outcome?: ToolResultEnvelope
    }> => {
      try {
        const value = await execute(args)
        const normalized = normalizeToolExecutionOutput(value)
        return {
          result: normalized.result,
          isError: false,
          timedOut: false,
          threw: false,
          outcome: normalized.outcome,
        }
      } catch (toolErr) {
        return {
          result: JSON.stringify({ error: (toolErr as Error).message }),
          isError: true,
          timedOut: false,
          threw: true,
          outcome: undefined,
        }
      }
    })()

    const timeoutMs = config.toolCallTimeoutMs
    const timeoutPromise = timeoutMs > 0
      ? new Promise<{
          result: string; isError: boolean; timedOut: boolean; threw: boolean; outcome?: ToolResultEnvelope
        }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({
              result: JSON.stringify({ error: `Tool "${toolName}" timed out after ${timeoutMs}ms` }),
              isError: true,
              timedOut: true,
              threw: false,
              outcome: undefined,
            })
          }, timeoutMs)
        })
      : undefined

    const attemptOutcome = timeoutPromise
      ? await Promise.race([toolCallPromise, timeoutPromise])
      : await toolCallPromise

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

    result = attemptOutcome.result
    isError = attemptOutcome.isError
    timedOut = attemptOutcome.timedOut
    const structuredOutcome = attemptOutcome.outcome
    if (structuredOutcome) {
      outcome = structuredOutcome
    }

    toolFailed = structuredOutcome ? !structuredOutcome.ok : didToolCallFail(isError, result)

    if (!toolFailed) break

    // Determine if this is a transport failure (retryable)
    const failureText = extractToolFailureText({ name: toolName, args, result, isError: true })
    const transportFailure = timedOut || attemptOutcome.threw || isLikelyTransportFailure(failureText)

    if (!transportFailure) break
    if (attempt >= maxRetries) break
    if (config.signal?.aborted) break

    // Check retry safety
    if (HIGH_RISK_TOOLS.has(toolName)) {
      const hasIdempotency = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0
      if (!hasIdempotency) {
        retrySuppressedReason = `Suppressed auto-retry for high-risk tool "${toolName}" without idempotencyKey`
        break
      }
    } else if (!SAFE_RETRY_TOOLS.has(toolName)) {
      retrySuppressedReason = `Suppressed auto-retry for potentially side-effecting tool "${toolName}"`
      break
    }

    retryCount++
  }

  const durationMs = Date.now() - toolStart
  return { result, isError, toolFailed, timedOut, retryCount, retrySuppressedReason, durationMs, outcome }
}

/**
 * Detect likely transport/infrastructure failures that warrant retry.
 */
export function isLikelyTransportFailure(errorText: string): boolean {
  const lower = errorText.toLowerCase()
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport")
  )
}

/**
 * Classify a tool as high-risk (has side effects).
 */
export function isHighRiskToolCall(toolName: string): boolean {
  return HIGH_RISK_TOOLS.has(toolName)
}

/**
 * Classify a tool as safe to retry on transport failure.
 */
export function isToolRetrySafe(toolName: string): boolean {
  return SAFE_RETRY_TOOLS.has(toolName)
}

// ============================================================================
// Stuck-loop detection
// ============================================================================

/** Mutable state for per-call failure tracking within a tool round. */
export interface ToolLoopState {
  lastFailKey: string
  consecutiveFailCount: number
}

/** Mutable state for cross-round stuck detection. */
export interface RoundStuckState {
  consecutiveAllFailedRounds: number
  lastRoundSemanticKey: string
  consecutiveSemanticDuplicateRounds: number
}

export interface StuckDetectionResult {
  readonly shouldBreak: boolean
  readonly reason?: string
}

/**
 * Track per-call consecutive failure counting within the tool loop.
 */
export function trackToolCallFailureState(
  toolFailed: boolean,
  semanticToolKey: string,
  loopState: ToolLoopState,
): void {
  const failKey = toolFailed ? semanticToolKey : ""
  if (toolFailed && failKey === loopState.lastFailKey) {
    loopState.consecutiveFailCount++
  } else {
    loopState.lastFailKey = failKey
    loopState.consecutiveFailCount = toolFailed ? 1 : 0
  }
}

/**
 * Check for stuck tool-loop patterns across rounds.
 *
 * Three levels:
 *   1. Per-call: N identical failing calls
 *   2. Per-round: N consecutive all-failed rounds
 *   3. Semantic: N consecutive rounds with same semantic key set (regardless of success)
 */
export function checkToolLoopStuckDetection(
  roundCalls: readonly ToolCallRecord[],
  loopState: ToolLoopState,
  stuckState: RoundStuckState,
): StuckDetectionResult {
  // Level 1: per-call identical failure
  if (loopState.consecutiveFailCount >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically-equivalent failing tool calls",
    }
  }

  if (roundCalls.length === 0) {
    return { shouldBreak: false }
  }

  // Level 2: all-failed rounds
  const roundFailures = roundCalls.filter(c => didToolCallFail(c.isError, c.result)).length
  if (roundFailures === roundCalls.length) {
    stuckState.consecutiveAllFailedRounds++
  } else {
    stuckState.consecutiveAllFailedRounds = 0
  }
  if (stuckState.consecutiveAllFailedRounds >= MAX_CONSECUTIVE_ALL_FAILED_ROUNDS) {
    return {
      shouldBreak: true,
      reason: `All tool calls failed for ${MAX_CONSECUTIVE_ALL_FAILED_ROUNDS} consecutive rounds`,
    }
  }

  // Level 3: semantic duplicate rounds (same tools + args, regardless of success/failure)
  const roundSemanticKey = roundCalls
    .map(c => buildSemanticToolCallKey(c.name, c.args))
    .sort()
    .join("|")
  if (roundSemanticKey.length > 0 && roundSemanticKey === stuckState.lastRoundSemanticKey) {
    stuckState.consecutiveSemanticDuplicateRounds++
  } else {
    stuckState.consecutiveSemanticDuplicateRounds = 0
  }
  stuckState.lastRoundSemanticKey = roundSemanticKey
  if (stuckState.consecutiveSemanticDuplicateRounds >= MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS) {
    return {
      shouldBreak: true,
      reason: "Detected repeated semantically equivalent tool rounds with no material progress",
    }
  }

  return { shouldBreak: false }
}

// Re-export progress summary and budget extension from tool-progress.ts
export {
    evaluateToolRoundBudgetExtension,
    summarizeToolRoundProgress
} from "./tool-progress.js"
export type {
    ToolRoundBudgetExtensionResult,
    ToolRoundProgressSummary
} from "./tool-progress.js"

// ============================================================================
// Enrichment helpers
// ============================================================================

/**
 * Enrich a JSON tool result with additional metadata fields.
 */
export function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
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
  const lastSuccessful = [...toolCalls].reverse().find(c => !didToolCallFail(c.isError, c.result))
  if (lastSuccessful) {
    return `Task completed. Last successful tool call: ${lastSuccessful.name}`
  }
  return "Task attempted but all tool calls failed. See tool results for details."
}
