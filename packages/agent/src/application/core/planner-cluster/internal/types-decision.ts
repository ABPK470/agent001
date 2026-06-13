/**
 * Planner routing decision types.
 *
 * Two execution modes only:
 *   direct  — agent tool loop (default)
 *   planner — structured plan + child agents
 *
 * @module
 */

import type { PlanEdge } from "../types.js"

export type PlannerRoute = "direct" | "planner"

export interface PlannerDecision {
  readonly route: PlannerRoute
  readonly reason: string
  readonly shouldPlan: boolean
  readonly score: number
}

// ── Coherent bundle types (plan artifacts only — not a routing lane) ──

export interface CoherentSolutionArtifact {
  readonly path: string
  readonly purpose: string
  readonly content: string
}

export interface CoherentSharedContract {
  readonly name: string
  readonly description: string
}

export interface CoherentSystemInvariant {
  readonly id: string
  readonly description: string
}

export interface CoherentArchitectureArtifact {
  readonly path: string
  readonly purpose: string
}

export interface PlannerCoherentBootstrap {
  readonly summary: string
  readonly architecture: string
  readonly artifacts: readonly CoherentArchitectureArtifact[]
  readonly dependencyEdges?: readonly PlanEdge[]
  readonly sharedContracts?: readonly CoherentSharedContract[]
  readonly invariants?: readonly CoherentSystemInvariant[]
  readonly decompositionStrategy: "preserve_coherence" | "decompose_by_ownership"
  readonly decompositionReasons: readonly string[]
}

export interface CoherentSolutionBundle {
  readonly summary: string
  readonly architecture: string
  readonly artifacts: readonly CoherentSolutionArtifact[]
  readonly dependencyEdges?: readonly PlanEdge[]
  readonly sharedContracts?: readonly CoherentSharedContract[]
  readonly invariants?: readonly CoherentSystemInvariant[]
}

export type ArchitecturePreservationStatus = "frozen" | "preserved" | "repairing_in_place" | "abandoned"
