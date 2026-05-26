/**
 * `executeToolWithTimeout` — runs a tool with timeout racing and
 * transport-failure retry classification (high-risk requires
 * idempotencyKey, safe-retry tools allowed, others suppressed).
 *
 * @module
 */

import { HIGH_RISK_TOOLS, SAFE_RETRY_TOOLS } from "../../../domain/agent-constants.js"
import type { ToolResultEnvelope } from "../../../types.js"
import {
    didToolCallFail,
    extractToolFailureText,
    normalizeToolExecutionOutput,
} from "../result.js"

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

/** Classify a tool as high-risk (has side effects). */
export function isHighRiskToolCall(toolName: string): boolean {
  return HIGH_RISK_TOOLS.has(toolName)
}

/** Classify a tool as safe to retry on transport failure. */
export function isToolRetrySafe(toolName: string): boolean {
  return SAFE_RETRY_TOOLS.has(toolName)
}
