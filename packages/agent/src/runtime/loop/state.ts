/**
 * Mutable state for the Agent's direct tool loop.
 *
 * @module
 */

import { ToolFailureCircuitBreaker } from "../../core/recovery.js"
import type { RoundStuckState, ToolLoopState, ToolRoundProgressSummary } from "../../../tools/index.js"

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
  lastAnswerSignature?: import("./loop-policy/answer-stability.js").AnswerSignature
}

const INITIAL_FULL_COMPACTION_OFFSET = -8

export function createAgentLoopState(maxIterations: number): AgentLoopState {
  return {
    toolLoopState: { lastFailKey: "", consecutiveFailCount: 0 },
    roundStuckState: {
      consecutiveAllFailedRounds: 0,
      lastRoundSemanticKey: "",
      consecutiveSemanticDuplicateRounds: 0
    },
    seenSuccessfulSemanticKeys: new Set(),
    seenVerificationFailureDiagKeys: new Set(),
    recentRoundSummaries: [],
    emittedRecoveryHints: new Set(),
    circuitBreaker: new ToolFailureCircuitBreaker(),
    lastRoundHadDelegation: false,
    lastDelegationWasReadOnly: false,
    wroteUnverifiedFiles: false,
    writeVerifyNudged: false,
    writtenButNotReread: new Set(),
    artifactsRequiringReadBeforeMutation: new Set(),
    fatalArtifactFailureCounts: new Map(),
    blockedArtifactFailureCounts: new Map(),
    writeReviewNudged: false,
    prematureHandoffNudges: 0,
    inPostDelegationVerification: false,
    verificationFoundIssues: false,
    earlyExitNudged: false,
    budgetNudged: false,
    groundednessNudged: false,
    completionValidated: false,
    completionAttempted: false,
    lastFullCompactionIteration: INITIAL_FULL_COMPACTION_OFFSET,
    absoluteIterationCap: maxIterations + 10,
    recentTruncatedQueries: [],
    cumulativeReadFileHistory: new Map(),
    lastAnswerSignature: undefined
  }
}
