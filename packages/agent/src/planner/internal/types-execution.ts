/**
 * Execution envelope, role, repair payload, and shared state contract types.
 * Extracted from planner/types.ts.
 *
 * @module
 */

import type { CoherentSharedContract, CoherentSystemInvariant } from "./types-decision.js"
import type { VerifierIssueSeverity, VerifierOwnershipMode, VerifierRepairClass } from "./types-verifier.js"

export type EffectClass =
  | "readonly"
  | "filesystem_write"
  | "filesystem_scaffold"
  | "shell"
  | "mixed"

export type VerificationMode =
  | "none"
  | "browser_check"
  | "run_tests"
  | "mutation_required"
  | "deterministic_followup"

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
  readonly preserveArchitecture?: boolean
  readonly architectureSummary?: string
  readonly sharedContracts?: readonly CoherentSharedContract[]
  readonly invariants?: readonly CoherentSystemInvariant[]
}

export type StepRole = "writer" | "reviewer" | "validator" | "grounding"

export interface WorkflowStepContract {
  readonly role: StepRole
  readonly artifactRelations: readonly ArtifactRelation[]
}

export interface ExecutionEnvelope {
  /** Working directory root for the child. */
  readonly workspaceRoot: string
  /** Directories the child may read from. */
  readonly allowedReadRoots: readonly string[]
  /** Directories the child may write to. */
  readonly allowedWriteRoots: readonly string[]
  /** Explicit tool allowlist (least-privilege). */
  readonly allowedTools: readonly string[]
  /** Source files/specs the child must read first. */
  readonly requiredSourceArtifacts: readonly string[]
  /** Files/dirs the child is expected to create/modify. */
  readonly targetArtifacts: readonly string[]
  /** What kind of filesystem effects this child produces. */
  readonly effectClass: EffectClass
  /** How the parent will verify this child's output. */
  readonly verificationMode: VerificationMode
  /** Typed ownership relations between this step and artifacts. */
  readonly artifactRelations: readonly ArtifactRelation[]
  /** Role of this step in the workflow (writer, reviewer, validator, grounding). */
  readonly role?: StepRole
  /** Optional shared-state contract for multi-file workflows. */
  readonly sharedStateContract?: SharedStateContract
  /** Explicit write forbiddance beyond owned artifacts. */
  readonly forbiddenArtifacts?: readonly string[]
  /** Deterministic checks the child should run before completion. */
  readonly requiredChecks?: readonly string[]
  /** Upstream artifacts already accepted by verification and safe to rely on. */
  readonly upstreamAcceptedArtifacts?: readonly string[]
  /** Dependency blockers that prevent this step from completing. */
  readonly unresolvedDependencyBlockers?: readonly string[]
  /** Typed repair context for retries/reverification. */
  readonly repairContext?: ChildRepairPayload
}
