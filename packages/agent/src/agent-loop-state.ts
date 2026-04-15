/**
 * Mutable state for the Agent's direct tool loop.
 *
 * Extracted from agent.ts to keep the main module focused on the loop
 * orchestration. Every flag and counter that the loop maintains across
 * iterations lives here.
 */

import { ToolFailureCircuitBreaker } from "./circuit-breaker.js"
import type { CoherentSolutionBundle, Plan, VerifierDecision } from "./planner/types.js"
import type { RoundStuckState, ToolLoopState, ToolRoundProgressSummary } from "./tool-utils.js"

/** Active coherent-generation execution context. */
export interface CoherentExecutionState {
  bundle: CoherentSolutionBundle
  verificationPlan: Plan
  repairAttempts: number
  escalated: boolean
  lastVerifierDecision?: VerifierDecision
  lastVerifiedToolCallCount: number
}

/** All mutable state used within the direct tool loop. */
export interface AgentLoopState {
  // ── Stuck detection ──
  toolLoopState: ToolLoopState
  roundStuckState: RoundStuckState
  seenSuccessfulSemanticKeys: Set<string>
  seenVerificationFailureDiagKeys: Set<string>
  recentRoundSummaries: ToolRoundProgressSummary[]

  // ── Recovery hints ──
  emittedRecoveryHints: Set<string>

  // ── Coherent repair ──
  coherentRepairReadOnlyRounds: number

  // ── Circuit breaker ──
  circuitBreaker: ToolFailureCircuitBreaker

  // ── Delegation & verification tracking ──
  lastRoundHadDelegation: boolean
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

  // ── One-shot guards ──
  earlyExitNudged: boolean
  budgetNudged: boolean
  completionValidated: boolean
  completionAttempted: boolean

  // ── Contract guidance ──
  lastRoundToolCallsSnapshot: readonly { name: string; isError: boolean }[]

  // ── Full compaction ──
  lastFullCompactionIteration: number

  // ── Iteration budget ──
  absoluteIterationCap: number

  // ── Coherent execution ──
  coherentExecution: CoherentExecutionState | null
}

const INITIAL_FULL_COMPACTION_OFFSET = -8

/** Create a fresh loop state for a new agent run. */
export function createAgentLoopState(maxIterations: number): AgentLoopState {
  return {
    toolLoopState: { lastFailKey: "", consecutiveFailCount: 0 },
    roundStuckState: {
      consecutiveAllFailedRounds: 0,
      lastRoundSemanticKey: "",
      consecutiveSemanticDuplicateRounds: 0,
    },
    seenSuccessfulSemanticKeys: new Set(),
    seenVerificationFailureDiagKeys: new Set(),
    recentRoundSummaries: [],
    emittedRecoveryHints: new Set(),
    coherentRepairReadOnlyRounds: 0,
    circuitBreaker: new ToolFailureCircuitBreaker(),
    lastRoundHadDelegation: false,
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
    completionValidated: false,
    completionAttempted: false,
    lastRoundToolCallsSnapshot: [],
    lastFullCompactionIteration: INITIAL_FULL_COMPACTION_OFFSET,
    absoluteIterationCap: maxIterations + 10,
    coherentExecution: null,
  }
}
