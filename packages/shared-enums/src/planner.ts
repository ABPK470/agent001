/**
 * Planner wire enums.
 *
 * Cross HTTP/WS/JSON boundaries: emitted in planner trace events
 * (`/api/runs/:id/trace`, SSE event stream) and consumed by the UI
 * Operation Log + IOE inspector. Both sides compare with `===`,
 * so values MUST match exactly.
 */

/** Top-level routing decision selected by the planner-first router. */
export const PlannerRoute = {
  Direct:                       "direct",
  SingleArtifactDirectBurst:    "single_artifact_direct_burst",
  BoundedCoherentGeneration:    "bounded_coherent_generation",
  PlannerWithCoherentBootstrap: "planner_with_coherent_bootstrap",
  FullPlannerDecomposition:     "full_planner_decomposition",
} as const

export type PlannerRoute = (typeof PlannerRoute)[keyof typeof PlannerRoute]

export const PLANNER_ROUTE_VALUES: ReadonlyArray<PlannerRoute> = Object.values(PlannerRoute)

export const isPlannerRoute = (value: unknown): value is PlannerRoute =>
  typeof value === "string" && (PLANNER_ROUTE_VALUES as readonly string[]).includes(value)

/** Coherence/coordination-need axis used by the planner-first router. */
export const PlannerNeedLevel = {
  Low:    "low",
  Medium: "medium",
  High:   "high",
} as const

export type PlannerNeedLevel = (typeof PlannerNeedLevel)[keyof typeof PlannerNeedLevel]

export const PLANNER_NEED_LEVELS: ReadonlyArray<PlannerNeedLevel> = Object.values(PlannerNeedLevel)

export const isPlannerNeedLevel = (value: unknown): value is PlannerNeedLevel =>
  typeof value === "string" && (PLANNER_NEED_LEVELS as readonly string[]).includes(value)

/** Decomposition strategy chosen during planner-coherent bootstrap. */
export const DecompositionStrategy = {
  PreserveCoherence:   "preserve_coherence",
  DecomposeByOwnership: "decompose_by_ownership",
} as const

export type DecompositionStrategy = (typeof DecompositionStrategy)[keyof typeof DecompositionStrategy]

export const DECOMPOSITION_STRATEGY_VALUES: ReadonlyArray<DecompositionStrategy> = Object.values(DecompositionStrategy)

export const isDecompositionStrategy = (value: unknown): value is DecompositionStrategy =>
  typeof value === "string" && (DECOMPOSITION_STRATEGY_VALUES as readonly string[]).includes(value)

/** Architecture state of an in-flight planner lane. */
export const PlannerArchitectureStatus = {
  Frozen:            "frozen",
  Preserved:         "preserved",
  RepairingInPlace:  "repairing_in_place",
  Abandoned:         "abandoned",
} as const

export type PlannerArchitectureStatus = (typeof PlannerArchitectureStatus)[keyof typeof PlannerArchitectureStatus]

export const PLANNER_ARCHITECTURE_STATUS_VALUES: ReadonlyArray<PlannerArchitectureStatus> = Object.values(PlannerArchitectureStatus)

export const isPlannerArchitectureStatus = (value: unknown): value is PlannerArchitectureStatus =>
  typeof value === "string" && (PLANNER_ARCHITECTURE_STATUS_VALUES as readonly string[]).includes(value)

/** Phase of a single planner-step lifecycle transition. */
export const PlannerStepPhase = {
  Execution:    "execution",
  Verification: "verification",
  Repair:       "repair",
} as const

export type PlannerStepPhase = (typeof PlannerStepPhase)[keyof typeof PlannerStepPhase]

export const PLANNER_STEP_PHASE_VALUES: ReadonlyArray<PlannerStepPhase> = Object.values(PlannerStepPhase)

export const isPlannerStepPhase = (value: unknown): value is PlannerStepPhase =>
  typeof value === "string" && (PLANNER_STEP_PHASE_VALUES as readonly string[]).includes(value)

/** Source attribution for a direct-loop fallback decision. */
export const DirectLoopFallbackSource = {
  PlannerDeclined:             "planner_declined",
  PlannerVerifierLowComplexity: "planner_verifier_low_complexity",
} as const

export type DirectLoopFallbackSource = (typeof DirectLoopFallbackSource)[keyof typeof DirectLoopFallbackSource]

export const DIRECT_LOOP_FALLBACK_SOURCE_VALUES: ReadonlyArray<DirectLoopFallbackSource> = Object.values(DirectLoopFallbackSource)

export const isDirectLoopFallbackSource = (value: unknown): value is DirectLoopFallbackSource =>
  typeof value === "string" && (DIRECT_LOOP_FALLBACK_SOURCE_VALUES as readonly string[]).includes(value)

/** Compatibility mode for the planner-repair shadow rollout. */
export const PlannerRepairCompatibilityMode = {
  Shadow: "shadow",
  Legacy: "legacy",
  Repair: "repair",
} as const

export type PlannerRepairCompatibilityMode = (typeof PlannerRepairCompatibilityMode)[keyof typeof PlannerRepairCompatibilityMode]

export const PLANNER_REPAIR_COMPATIBILITY_MODES: ReadonlyArray<PlannerRepairCompatibilityMode> = Object.values(PlannerRepairCompatibilityMode)

export const isPlannerRepairCompatibilityMode = (value: unknown): value is PlannerRepairCompatibilityMode =>
  typeof value === "string" && (PLANNER_REPAIR_COMPATIBILITY_MODES as readonly string[]).includes(value)

/** Path actually taken under a planner-repair compatibility mode. */
export const PlannerRepairActivePath = {
  Legacy: "legacy",
  Repair: "repair",
} as const

export type PlannerRepairActivePath = (typeof PlannerRepairActivePath)[keyof typeof PlannerRepairActivePath]

export const PLANNER_REPAIR_ACTIVE_PATHS: ReadonlyArray<PlannerRepairActivePath> = Object.values(PlannerRepairActivePath)

export const isPlannerRepairActivePath = (value: unknown): value is PlannerRepairActivePath =>
  typeof value === "string" && (PLANNER_REPAIR_ACTIVE_PATHS as readonly string[]).includes(value)

/** Outcome of a verifier pass over a planner step's output. */
export const VerifierOutcome = {
  Pass:  "pass",
  Retry: "retry",
  Fail:  "fail",
} as const

export type VerifierOutcome = (typeof VerifierOutcome)[keyof typeof VerifierOutcome]

export const VERIFIER_OUTCOMES: ReadonlyArray<VerifierOutcome> = Object.values(VerifierOutcome)

export const isVerifierOutcome = (value: unknown): value is VerifierOutcome =>
  typeof value === "string" && (VERIFIER_OUTCOMES as readonly string[]).includes(value)

/** Per-task disposition inside a RepairPlan. */
export const VerifierMode = {
  Repair:   "repair",
  Reverify: "reverify",
  Blocked:  "blocked",
} as const

export type VerifierMode = (typeof VerifierMode)[keyof typeof VerifierMode]

export const VERIFIER_MODES: ReadonlyArray<VerifierMode> = Object.values(VerifierMode)

export const isVerifierMode = (value: unknown): value is VerifierMode =>
  typeof value === "string" && (VERIFIER_MODES as readonly string[]).includes(value)

/** Per-step verifier strategy (how a step's output gets checked). */
export const VerificationMode = {
  None:                  "none",
  BrowserCheck:          "browser_check",
  RunTests:              "run_tests",
  MutationRequired:      "mutation_required",
  DeterministicFollowup: "deterministic_followup",
} as const

export type VerificationMode = (typeof VerificationMode)[keyof typeof VerificationMode]

export const VERIFICATION_MODES: ReadonlyArray<VerificationMode> = Object.values(VerificationMode)

export const isVerificationMode = (value: unknown): value is VerificationMode =>
  typeof value === "string" && (VERIFICATION_MODES as readonly string[]).includes(value)
