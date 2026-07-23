/**
 * Planner delegation port types — owned by domain so AgentConfig can name them
 * without importing core.
 */

import type { EffectClass } from "../enums/delegation.js"
import type {
  StepRole,
  VerificationMode,
  VerifierIssueSeverity,
} from "../enums/planner.js"

export type VerifierOwnershipMode =
  | "deterministic_owner"
  | "shared_owners"
  | "integration_layer"
  | "planner_fault"
  | "ambiguous"

export type VerifierRepairClass =
  | "owner_implementation"
  | "integration_wiring"
  | "contract_drift"
  | "path_scope"
  | "runtime_failure"
  | "syntax_failure"
  | "placeholder_logic"
  | "verification_gap"

export interface ArtifactRelation {
  readonly relationType: "read_dependency" | "write_owner"
  readonly artifactPath: string
}

export interface SharedStateContract {
  readonly contractId: string
  readonly ownerStepName: string
  readonly ownerArtifactPath: string
  readonly schema: string
  readonly mutationPolicy: "owner-only"
}

export interface ChildRepairGoal {
  readonly issueCode: string
  readonly summary: string
  readonly severity: VerifierIssueSeverity
  readonly repairClass: VerifierRepairClass
  readonly confidence: number
  readonly ownershipMode: VerifierOwnershipMode
  readonly suspectedOwners: readonly string[]
  readonly primaryOwner?: string
  readonly affectedArtifacts: readonly string[]
  readonly sourceArtifacts: readonly string[]
  readonly guidance?: string
}

export interface ChildRepairPayload {
  readonly mode: "initial" | "repair" | "reverify" | "blocked"
  readonly goals: readonly ChildRepairGoal[]
  readonly dependencyGoals: readonly ChildRepairGoal[]
  readonly requiredAcceptedArtifacts: readonly string[]
  readonly unresolvedDependencyBlockers: readonly string[]
}

export interface WorkflowStepContract {
  readonly role: StepRole
  readonly artifactRelations: readonly ArtifactRelation[]
}

export interface ExecutionEnvelope {
  readonly workspaceRoot: string
  readonly allowedReadRoots: readonly string[]
  readonly allowedWriteRoots: readonly string[]
  readonly allowedTools: readonly string[]
  readonly requiredSourceArtifacts: readonly string[]
  readonly targetArtifacts: readonly string[]
  readonly effectClass: EffectClass
  readonly verificationMode: VerificationMode
  readonly artifactRelations: readonly ArtifactRelation[]
  readonly role?: StepRole
  readonly sharedStateContract?: SharedStateContract
  readonly forbiddenArtifacts?: readonly string[]
  readonly requiredChecks?: readonly string[]
  readonly upstreamAcceptedArtifacts?: readonly string[]
  readonly unresolvedDependencyBlockers?: readonly string[]
  readonly repairContext?: ChildRepairPayload
}

export interface DeterministicToolStep {
  readonly name: string
  readonly stepType: "deterministic_tool"
  readonly dependsOn?: readonly string[]
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly onError?: "retry" | "skip" | "abort"
  readonly maxRetries?: number
}

export interface SubagentTaskStep {
  readonly name: string
  readonly stepType: "subagent_task"
  readonly dependsOn?: readonly string[]
  readonly objective: string
  readonly inputContract: string
  readonly acceptanceCriteria: readonly string[]
  readonly requiredToolCapabilities: readonly string[]
  readonly contextRequirements: readonly string[]
  readonly executionContext: ExecutionEnvelope
  readonly maxBudgetHint: string
  readonly canRunParallel: boolean
  readonly workflowStep?: WorkflowStepContract
}

export type PlanStep = DeterministicToolStep | SubagentTaskStep

/** Result of a delegated child run — opaque extras stay optional for domain. */
export interface DelegateResult {
  readonly output: string
  readonly toolCalls?: readonly unknown[]
  readonly execution?: unknown
}

export type PlannerDelegateFn = (
  step: SubagentTaskStep,
  envelope: ExecutionEnvelope,
) => Promise<DelegateResult>

export type DelegateFn = PlannerDelegateFn
