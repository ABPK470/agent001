/**
 * Retry with exponential backoff + jitter.
 *
 * Wraps any async function with retry logic:
 *   - Exponential backoff: delay doubles each attempt
 *   - Jitter: random spread to prevent thundering herd
 *   - Configurable max retries, max delay
 *   - Returns the result or throws after exhausting retries
 *
 * Used by the message queue to retry failed API calls to
 * WhatsApp/Messenger without overwhelming rate limits.
 */

import type { RetryPolicy } from "./types.js"

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
  jitterFactor: 0.5,
}

/** Compute the delay for a given attempt (0-indexed). */
export function computeDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * policy.jitterFactor * Math.random()
  return capped + jitter
}

/** Whether an HTTP status code is retryable. */
export function isRetryableStatus(status: number): boolean {
  // 429 = rate limited, 5xx = server errors
  return status === 429 || (status >= 500 && status < 600)
}

/** Error type that carries an HTTP status for retry decisions. */
export class ChannelApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly responseBody?: unknown,
  ) {
    super(message)
    this.name = "ChannelApiError"
  }

  get retryable(): boolean {
    return isRetryableStatus(this.statusCode)
  }
}

export interface RetryResult<T> {
  success: boolean
  value?: T
  attempts: number
  lastError?: Error
}

/**
 * Execute a function with retry.
 *
 * Only retries on ChannelApiError with retryable status codes.
 * Non-retryable errors (400, 401, 403, 404) fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<RetryResult<T>> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const value = await fn()
      return { success: true, value, attempts: attempt + 1 }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry non-retryable errors
      if (err instanceof ChannelApiError && !err.retryable) {
        return { success: false, attempts: attempt + 1, lastError }
      }

      // Don't wait after the last attempt
      if (attempt < policy.maxRetries) {
        const delay = computeDelay(attempt, policy)
        await sleep(delay)
      }
    }
  }

  return { success: false, attempts: policy.maxRetries + 1, lastError }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
