import { PlannerNeedLevel } from "../../domain/enums/planner.js"
export { PlannerNeedLevel }
/**
 * Coherent solution / bootstrap types and routing decision types.
 * Extracted from planner/types.ts.
 *
 * @module
 */

import type { PlanEdge } from "../types.js"

export type PlannerRoute =
  | "direct"
  | "single_artifact_direct_burst"
  | "bounded_coherent_generation"
  | "planner_with_coherent_bootstrap"
  | "full_planner_decomposition"

export type ArchitecturePreservationStatus =
  | "frozen"
  | "preserved"
  | "repairing_in_place"
  | "abandoned"

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

/**
 * Confidence the routing system has in its decision.
 */
export type RoutingConfidence =
  | "decisive_planner"
  | "lean_planner"
  | "ambiguous"
  | "lean_coherent"
  | "decisive_coherent"

export interface PlannerDecision {
  readonly score: number
  readonly shouldPlan: boolean
  readonly reason: string
  readonly route: PlannerRoute
  readonly coherenceNeed: PlannerNeedLevel
  readonly coordinationNeed: PlannerNeedLevel
  /** How confident the routing system is. "ambiguous" cases use LLM routing. */
  readonly routingConfidence: RoutingConfidence
  /** True when LLM classification overrode the heuristic signal layer. */
  readonly llmClassified: boolean
}
