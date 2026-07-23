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

/** Summary of one tool round for progress / budget extension heuristics. */
export interface ToolRoundProgressSummary {
  readonly durationMs: number
  readonly totalCalls: number
  readonly successfulCalls: number
  readonly newSuccessfulSemanticKeys: number
  readonly newVerificationFailureDiagnosticKeys: number
  readonly hadSuccessfulMutation: boolean
  readonly hadVerificationCall: boolean
  readonly hadReadCall: boolean
  readonly hadMaterialProgress: boolean
}
