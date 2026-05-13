/**
 * Tool failure circuit breaker — ported from agenc-core (169 lines).
 *
 * Tracks repeated tool failures per session and opens a circuit breaker
 * when a tool fails too many times within a time window. Prevents the
 * agent from repeatedly calling tools that are known to be broken.
 *
 * agenc-core enhancement: per-key blocking.
 * When a specific semantic key hits the failure threshold, only that key is
 * blocked (not all tool calls). The global circuit only opens when many
 * distinct keys fail — indicating a systemic infrastructure issue.
 *
 * @module
 */

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_WINDOW_MS = 120_000
const DEFAULT_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60_000
/** Number of distinct blocked keys before the GLOBAL circuit opens. */
const DEFAULT_GLOBAL_CIRCUIT_THRESHOLD = 3

// ============================================================================
// Types
// ============================================================================

interface FailurePattern {
  count: number
  lastAt: number
}

interface BlockedKeyEntry {
  blockedUntil: number
  reason: string
}

interface CircuitState {
  openUntil: number
  reason: string | undefined
  patterns: Map<string, FailurePattern>
}

export interface CircuitBreakerConfig {
  enabled?: boolean
  /** Time window in ms for counting failures (default: 120s). */
  windowMs?: number
  /** Number of failures within window before tripping a single key (default: 3). */
  threshold?: number
  /** How long a blocked key (and the global circuit) stays blocked after tripping (default: 60s). */
  cooldownMs?: number
  /**
   * Number of distinct blocked keys before the GLOBAL circuit opens (default: 3).
   * Set to 1 for the legacy behaviour where any single key trips the global circuit.
   */
  globalCircuitThreshold?: number
}

// ============================================================================
// Circuit Breaker
// ============================================================================

export class ToolFailureCircuitBreaker {
  private readonly enabled: boolean
  private readonly windowMs: number
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly globalCircuitThreshold: number
  private readonly state: CircuitState
  /** Per-key blocked entries — expire at blockedUntil. */
  private readonly blockedKeys = new Map<string, BlockedKeyEntry>()

  constructor(config?: CircuitBreakerConfig) {
    this.enabled = config?.enabled ?? true
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS
    this.threshold = config?.threshold ?? DEFAULT_THRESHOLD
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.globalCircuitThreshold = config?.globalCircuitThreshold ?? DEFAULT_GLOBAL_CIRCUIT_THRESHOLD
    this.state = { openUntil: 0, reason: undefined, patterns: new Map() }
  }

  /**
   * Check whether a specific semantic key is currently blocked.
   *
   * Use this for per-call pre-flight checks so the agent can skip a specific
   * failing call while still allowing other tool calls in the same round.
   * Returns the block reason + cooldown remaining, or null if not blocked.
   */
  isKeyBlocked(semanticKey: string): { reason: string; retryAfterMs: number } | null {
    if (!this.enabled || semanticKey.length === 0) return null
    const now = Date.now()
    const entry = this.blockedKeys.get(semanticKey)
    if (!entry) return null
    if (entry.blockedUntil <= now) {
      this.blockedKeys.delete(semanticKey)
      return null
    }
    return { reason: entry.reason, retryAfterMs: Math.max(0, entry.blockedUntil - now) }
  }

  /**
   * Check if the GLOBAL circuit is open (systemic failure — all tool calls blocked).
   *
   * The global circuit only opens when many distinct semantic keys have each hit
   * the failure threshold, indicating an infrastructure-level problem rather than
   * a single bad tool invocation.
   *
   * Returns the blocking reason, or null if circuit is closed.
   */
  getActiveCircuit(): { reason: string; retryAfterMs: number } | null {
    if (!this.enabled) return null
    const now = Date.now()
    if (this.state.openUntil <= now) {
      this.state.openUntil = 0
      this.state.reason = undefined
      return null
    }
    return {
      reason: this.state.reason ?? "Circuit breaker open after repeated tool failures",
      retryAfterMs: Math.max(0, this.state.openUntil - now),
    }
  }

  /**
   * Record a tool failure.
   *
   * When the failure count for `semanticKey` reaches the threshold:
   *   - That key is added to the per-key blocked set (use `isKeyBlocked()` for checks).
   *   - If the number of distinct blocked keys reaches `globalCircuitThreshold`,
   *     the global circuit also opens.
   *
   * Returns the per-key block reason if the key just tripped, or undefined otherwise.
   */
  recordFailure(semanticKey: string, toolName: string): string | undefined {
    if (!this.enabled || semanticKey.length === 0) return undefined

    const now = Date.now()

    // Expire old patterns outside the window
    for (const [key, pattern] of this.state.patterns) {
      if (now - pattern.lastAt > this.windowMs) {
        this.state.patterns.delete(key)
      }
    }
    // Expire stale per-key blocks
    for (const [key, entry] of this.blockedKeys) {
      if (entry.blockedUntil <= now) this.blockedKeys.delete(key)
    }

    const existing = this.state.patterns.get(semanticKey)
    const next: FailurePattern = existing
      ? { count: existing.count + 1, lastAt: now }
      : { count: 1, lastAt: now }
    this.state.patterns.set(semanticKey, next)

    if (next.count < this.threshold) return undefined

    // Key has hit the threshold — block this specific key
    const keyReason =
      `Tool "${toolName}" failed ${next.count} times within ${this.windowMs}ms — ` +
      `this specific call pattern is blocked. Try a different approach.`
    this.blockedKeys.set(semanticKey, { blockedUntil: now + this.cooldownMs, reason: keyReason })

    // Open the global circuit only when many distinct keys are blocked (systemic failure)
    if (this.blockedKeys.size >= this.globalCircuitThreshold) {
      this.state.openUntil = now + this.cooldownMs
      this.state.reason =
        `Circuit breaker opened: ${this.blockedKeys.size} distinct tool patterns ` +
        `have each failed ${this.threshold}+ times — likely a systemic issue.`
    }

    return keyReason
  }

  /**
   * Clear a failure pattern when a tool succeeds (reset that key).
   */
  clearPattern(semanticKey: string): void {
    if (!this.enabled || semanticKey.length === 0) return
    this.state.patterns.delete(semanticKey)
    this.blockedKeys.delete(semanticKey)
    // If the global circuit was open, re-evaluate: close it if blocked count dropped
    if (this.state.openUntil > 0 && this.blockedKeys.size < this.globalCircuitThreshold) {
      const now = Date.now()
      if (this.state.openUntil > now) {
        // Enough keys cleared — close global circuit early
        if (this.blockedKeys.size === 0) {
          this.state.openUntil = 0
          this.state.reason = undefined
        }
      }
    }
  }

  /**
   * Reset all tracked state.
   */
  reset(): void {
    this.state.openUntil = 0
    this.state.reason = undefined
    this.state.patterns.clear()
    this.blockedKeys.clear()
  }
}
