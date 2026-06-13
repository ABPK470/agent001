/**
 * Mutable state for the Agent's direct tool loop.
 *
 * Extracted from agent.ts to keep the main module focused on the loop
 * orchestration. Every flag and counter that the loop maintains across
 * iterations lives here.
 */

import type { CoherentSolutionBundle, Plan, VerifierDecision } from "../../core/planner.js"
import { ToolFailureCircuitBreaker } from "../../core/recovery.js"
import type { RoundStuckState, ToolLoopState, ToolRoundProgressSummary } from "../../../tools/index.js"

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
  /**
   * True when the most recent delegation restricted the child to read-only
   * tools (analysis only). Such delegations don't need post-hoc verification
   * via run_command/read_file — there's nothing to verify.
   */
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

  // ── One-shot guards ──
  earlyExitNudged: boolean
  budgetNudged: boolean
  groundednessNudged: boolean
  completionValidated: boolean
  completionAttempted: boolean

  // ── Full compaction ──
  lastFullCompactionIteration: number

  // ── Iteration budget ──
  absoluteIterationCap: number

  // ── Coherent execution ──
  coherentExecution: CoherentExecutionState | null

  /**
   * Recent query_mssql results that hit the truncation cap. Each entry stores
   * the fingerprint (a distinctive substring of the rendered output) AND the
   * SQL that produced it, so the write_file anti-paste guard can suggest the
   * exact export_query_to_file call to make. Bounded to the last 4.
   */
  recentTruncatedQueries: Array<{ fingerprint: string; query: string }>

  /**
   * Cumulative read_file call count per file (by basename) across all rounds.
   * Used to detect the "sandwich read" pattern where the same file is read
   * repeatedly (via relative and absolute sandbox paths) across many rounds
   * without any write in between.
   */
  cumulativeReadFileHistory: Map<string, number>

  /**
   * Structural signature of the last assistant message that had no tool
   * calls and looked like a real final answer (table + header + conclusion).
   * Used by the answer-stability completion override to detect that the
   * model has converged and stop downstream guards from re-nudging.
   */
  lastAnswerSignature?: import("./completion-guards/answer-stability-guard.js").AnswerSignature
}

const INITIAL_FULL_COMPACTION_OFFSET = -8

/** Create a fresh loop state for a new agent run. */
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
    coherentRepairReadOnlyRounds: 0,
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
    coherentExecution: null,
    recentTruncatedQueries: [],
    cumulativeReadFileHistory: new Map(),
    lastAnswerSignature: undefined
  }
}
