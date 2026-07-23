/** Circuit breaker surface tracked in agent loop state (implementation in core/recover). */
export interface ToolFailureCircuitBreakerPort {
  getActiveCircuit(): { reason: string; retryAfterMs: number } | null
  isKeyBlocked(key: string): { reason: string; retryAfterMs: number } | null
  recordFailure(key: string, toolName: string): string | undefined
  clearPattern(semanticKey: string): void
}
