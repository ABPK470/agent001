/**
 * Tests for tool retry with exponential backoff + jitter.
 */

import { describe, expect, it, vi } from "vitest"
import {
    computeDelay,
    isRetryableError,
    TOOL_RETRY_POLICY,
    withToolRetry,
    type ToolRetryPolicy,
} from "../src/retry.js"

// ── computeDelay ─────────────────────────────────────────────────

describe("computeDelay", () => {
  const policy: ToolRetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 2000,
    backoffMultiplier: 2,
    jitterFactor: 0, // no jitter for deterministic tests
  }

  it("increases exponentially", () => {
    expect(computeDelay(0, policy)).toBe(100) // 100 * 2^0
    expect(computeDelay(1, policy)).toBe(200) // 100 * 2^1
    expect(computeDelay(2, policy)).toBe(400) // 100 * 2^2
    expect(computeDelay(3, policy)).toBe(800) // 100 * 2^3
  })

  it("caps at maxDelayMs", () => {
    expect(computeDelay(10, policy)).toBe(2000)
  })

  it("adds jitter within range", () => {
    const jitteryPolicy = { ...policy, jitterFactor: 0.3 }
    const delays = Array.from({ length: 50 }, () => computeDelay(0, jitteryPolicy))
    // base=100, jitter up to 30 → range [100, 130]
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(100)
      expect(d).toBeLessThanOrEqual(130)
    }
  })
})

// ── isRetryableError ─────────────────────────────────────────────

describe("isRetryableError", () => {
  it("marks timeout errors as retryable", () => {
    expect(isRetryableError(new Error("Request timeout"))).toBe(true)
    expect(isRetryableError(new Error("Connection timed out"))).toBe(true)
  })

  it("marks network errors as retryable", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true)
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true)
    expect(isRetryableError(new Error("socket hang up"))).toBe(true)
  })

  it("marks rate-limit/server errors as retryable", () => {
    expect(isRetryableError(new Error("429 Too Many Requests"))).toBe(true)
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true)
    expect(isRetryableError(new Error("500 Internal Server Error"))).toBe(true)
  })

  it("marks non-Error values as NOT retryable", () => {
    expect(isRetryableError("string error")).toBe(false)
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(42)).toBe(false)
  })

  it("marks validation/logic errors as NOT retryable", () => {
    expect(isRetryableError(new Error("Invalid argument"))).toBe(false)
    expect(isRetryableError(new Error("Permission denied"))).toBe(false)
    expect(isRetryableError(new Error("Not found"))).toBe(false)
  })
})

// ── withToolRetry ────────────────────────────────────────────────

describe("withToolRetry", () => {
  const fastPolicy: ToolRetryPolicy = {
    ...TOOL_RETRY_POLICY,
    baseDelayMs: 1,
    maxDelayMs: 1,
  }

  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok")
    const result = await withToolRetry(fn, fastPolicy)
    expect(result).toEqual({ success: true, value: "ok", attempts: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on retryable errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("recovered")

    const result = await withToolRetry(fn, fastPolicy)
    expect(result.success).toBe(true)
    expect(result.value).toBe("recovered")
    expect(result.attempts).toBe(2)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("validation failed"))
    const result = await withToolRetry(fn, fastPolicy)
    expect(result.success).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.lastError?.message).toBe("validation failed")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("gives up after maxRetries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout"))
    const result = await withToolRetry(fn, fastPolicy)
    expect(result.success).toBe(false)
    expect(result.attempts).toBe(fastPolicy.maxRetries + 1)
    expect(fn).toHaveBeenCalledTimes(fastPolicy.maxRetries + 1)
  })

  it("wraps non-Error throws into Error", async () => {
    const fn = vi.fn().mockRejectedValue("plain string")
    const result = await withToolRetry(fn, fastPolicy)
    expect(result.success).toBe(false)
    expect(result.lastError).toBeInstanceOf(Error)
    expect(result.lastError?.message).toBe("plain string")
  })
})
