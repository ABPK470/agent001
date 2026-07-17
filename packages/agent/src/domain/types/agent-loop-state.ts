/**
 * Shape of mutable agent loop state.
 *
 * Lives in domain so core can name the type without importing runtime.
 * Runtime owns the factory (`createAgentLoopState`) and may narrow fields.
 */

import type { ToolFailureCircuitBreaker } from "../../core/recover.js"
import type { RoundStuckState, ToolLoopState, ToolRoundProgressSummary } from "../../tools/index.js"

export interface AgentLoopState {
  toolLoopState: ToolLoopState
  roundStuckState: RoundStuckState
  seenSuccessfulSemanticKeys: Set<string>
  seenVerificationFailureDiagKeys: Set<string>
  recentRoundSummaries: ToolRoundProgressSummary[]
  emittedRecoveryHints: Set<string>
  circuitBreaker: ToolFailureCircuitBreaker
  lastRoundHadDelegation: boolean
  lastDelegationWasReadOnly: boolean
  wroteUnverifiedFiles: boolean
  writeVerifyNudged: boolean
  writtenButNotReread: Set<string>
  artifactsRequiringReadBeforeMutation: Set<string>
  fatalArtifactFailureCounts: Map<string, number>
  blockedArtifactFailureCounts: Map<string, number>
  writeReviewNudged: boolean
  prematureHandoffNudges: number
  inPostDelegationVerification: boolean
  verificationFoundIssues: boolean
  earlyExitNudged: boolean
  budgetNudged: boolean
  groundednessNudged: boolean
  completionValidated: boolean
  completionAttempted: boolean
  lastFullCompactionIteration: number
  absoluteIterationCap: number
  recentTruncatedQueries: Array<{ fingerprint: string; query: string }>
  cumulativeReadFileHistory: Map<string, number>
  /** Opaque to domain; runtime loop-policy owns the concrete shape. */
  lastAnswerSignature?: unknown
}
