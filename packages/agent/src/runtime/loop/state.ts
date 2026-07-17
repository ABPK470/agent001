/**
 * Mutable state for the Agent's direct tool loop.
 *
 * Type lives in domain; factory lives here (runtime owns construction).
 */

import { ToolFailureCircuitBreaker } from "../../core/recover.js"
import type { AgentLoopState as DomainAgentLoopState } from "../../domain/models/agent-loop-state.js"
import type { AnswerSignature } from "./loop-policy/answer-stability.js"

export type AgentLoopState = DomainAgentLoopState & {
  lastAnswerSignature?: AnswerSignature
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
