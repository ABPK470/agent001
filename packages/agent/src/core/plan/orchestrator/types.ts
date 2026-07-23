/**
 * Public interfaces for the planner orchestrator.
 * @module
 */

import type {
  DelegationBanditTunerPort,
  DelegationTrajectoryRecord,
} from "../../../domain/types/delegation-learning.js"
import type { LLMClient, Message, Tool } from "../../types.js"
import type {
  PipelineResult,
  Plan,
  PlanExecutionMode,
  PlannerDecision,
  PlannerRuntimeModel,
  VerifierDecision
} from "../types.js"

export interface PlannerContext {
  /** LLM client. */
  readonly llm: LLMClient
  /** Available tools. */
  readonly tools: readonly Tool[]
  /** Workspace root path. */
  readonly workspaceRoot: string
  /** Conversation history. */
  readonly history: readonly Message[]
  /** Abort signal. */
  readonly signal?: AbortSignal
  /** Called with trace events for UI. */
  readonly onTrace?: (entry: Record<string, unknown>) => void
  /**
   * Optional delegation bandit tuner.
   * When provided, UCB1 arm selection adjusts the effective score threshold
   * for delegation decisions and records outcomes for online learning.
   */
  readonly delegationBanditTuner?: DelegationBanditTunerPort
}

export interface PlannerResult {
  /** Did the planner handle this task? */
  readonly handled: boolean
  /** Final answer if handled. */
  readonly answer?: string
  /** The plan that was generated (for debug/trace). */
  readonly plan?: Plan
  /** Pipeline result (for debug/trace). */
  readonly pipelineResult?: PipelineResult
  /** Verifier decision (for debug/trace). */
  readonly verifierDecision?: VerifierDecision
  /** Reason the planner didn't handle the task (if !handled). */
  readonly skipReason?: string
}

/** Resolved setup context passed to the execution loop after Steps 1–3b succeed. */
export interface PlannerSetupContext {
  readonly plan: Plan
  readonly runtimeModel: PlannerRuntimeModel
  readonly decision: PlannerDecision
  readonly banditTrajectory: DelegationTrajectoryRecord | undefined
  /** Tier 1 decision from `runDelegationGate` — how the plan's subagent steps execute. */
  readonly executionMode: PlanExecutionMode
}
