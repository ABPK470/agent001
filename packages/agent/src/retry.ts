/**
 * Tool retry — exponential backoff with jitter for tool execution.
 *
 * Reuses the same proven pattern as channels/retry.ts but adapted for
 * tool execution in the governance layer:
 *   - Exponential backoff: delay doubles each attempt
 *   - Jitter: random spread to prevent thundering herd
 *   - Configurable max retries and delays
 *   - Only retries transient errors (timeouts, network, rate limits)
 *
 * Usage:
 *   const result = await withToolRetry(() => tool.execute(args), TOOL_RETRY_POLICY)
 */

// ── Policy ───────────────────────────────────────────────────────

export interface ToolRetryPolicy {
  /** Maximum number of retries (0 = no retry, just run once). */
  maxRetries: number
  /** Base delay in ms before first retry. */
  baseDelayMs: number
  /** Maximum delay cap in ms. */
  maxDelayMs: number
  /** Multiplier for exponential backoff. */
  backoffMultiplier: number
  /** Random jitter factor (0–1). */
  jitterFactor: number
}

/** Default: 2 retries, 500ms base, 5s max. */
export const TOOL_RETRY_POLICY: ToolRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  backoffMultiplier: 2,
  jitterFactor: 0.3,
}

// ── Retry helpers ────────────────────────────────────────────────

export function computeDelay(attempt: number, policy: ToolRetryPolicy): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * policy.jitterFactor * Math.random()
  return capped + jitter
}

/** Heuristic: is this error likely transient (worth retrying)? */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500")
  )
}

// ── Result type ──────────────────────────────────────────────────

export interface ToolRetryResult {
  success: boolean
  value?: string
  attempts: number
  lastError?: Error
}

// ── Execute with retry ───────────────────────────────────────────

/**
 * Execute a tool function with retry on transient errors.
 *
 * Non-retryable errors (validation, permission, logic) fail immediately.
 * Retryable errors (timeout, network, rate limit) retry with backoff.
 */
export async function withToolRetry(
  fn: () => Promise<string>,
  policy: ToolRetryPolicy = TOOL_RETRY_POLICY,
): Promise<ToolRetryResult> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const value = await fn()
      return { success: true, value, attempts: attempt + 1 }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry non-transient errors
      if (!isRetryableError(err)) {
        return { success: false, attempts: attempt + 1, lastError }
      }

      // Don't wait after the last attempt
      if (attempt < policy.maxRetries) {
        const delay = computeDelay(attempt, policy)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  return { success: false, attempts: policy.maxRetries + 1, lastError }
}
