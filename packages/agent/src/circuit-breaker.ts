/**
 * Tool failure circuit breaker — ported from agenc-core (169 lines).
 *
 * Tracks repeated tool failures per session and opens a circuit breaker
 * when a tool fails too many times within a time window. Prevents the
 * agent from repeatedly calling tools that are known to be broken.
 *
 * @module
 */

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_WINDOW_MS = 120_000
const DEFAULT_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60_000

// ============================================================================
// Types
// ============================================================================

interface FailurePattern {
  count: number
  lastAt: number
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
  /** Number of failures within window before tripping (default: 3). */
  threshold?: number
  /** How long the circuit stays open after tripping (default: 60s). */
  cooldownMs?: number
}

// ============================================================================
// Circuit Breaker
// ============================================================================

export class ToolFailureCircuitBreaker {
  private readonly enabled: boolean
  private readonly windowMs: number
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly state: CircuitState

  constructor(config?: CircuitBreakerConfig) {
    this.enabled = config?.enabled ?? true
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS
    this.threshold = config?.threshold ?? DEFAULT_THRESHOLD
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.state = { openUntil: 0, reason: undefined, patterns: new Map() }
  }

  /**
   * Check if the circuit is open (tool calls should be blocked).
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
   * Record a tool failure. Returns the circuit-open reason if the breaker trips.
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

    const existing = this.state.patterns.get(semanticKey)
    const next: FailurePattern = existing
      ? { count: existing.count + 1, lastAt: now }
      : { count: 1, lastAt: now }
    this.state.patterns.set(semanticKey, next)

    if (next.count < this.threshold) return undefined

    this.state.openUntil = now + this.cooldownMs
    this.state.reason =
      `Circuit breaker opened after ${next.count} repeated failures for tool "${toolName}" ` +
      `within ${this.windowMs}ms`
    return this.state.reason
  }

  /**
   * Clear a failure pattern when a tool succeeds (reset that key).
   */
  clearPattern(semanticKey: string): void {
    if (!this.enabled || semanticKey.length === 0) return
    this.state.patterns.delete(semanticKey)
    if (this.state.patterns.size === 0 && this.state.openUntil <= Date.now()) {
      this.state.openUntil = 0
      this.state.reason = undefined
    }
  }

  /**
   * Reset all tracked state.
   */
  reset(): void {
    this.state.openUntil = 0
    this.state.reason = undefined
    this.state.patterns.clear()
  }
}
