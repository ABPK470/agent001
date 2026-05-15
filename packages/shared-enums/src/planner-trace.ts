/**
 * Trace event kind enums for the planner observability stream.
 *
 * `onPlannerTrace` receives loose `Record<string, unknown>` envelopes,
 * but the `kind` discriminator string is contract-stable wire format
 * consumed by the UI / IOE / server. These enums make the kind set the
 * single source of truth so call sites can no longer drift via typos.
 *
 * @module
 */

// ── PlannerTraceKind (orchestrator + verifier + routing) ────────────────────
export const PlannerTraceKind = {
  ArchitectureState:          "planner-architecture-state",
  Decision:                   "planner-decision",
  CoherentBootstrap:          "planner-coherent-bootstrap",
  PlatformUnconfigured:       "planner-platform-unconfigured",
  GenerationFailed:           "planner-generation-failed",
  PlanGenerated:              "planner-plan-generated",
  ValidationFailed:           "planner-validation-failed",
  ValidationWarnings:         "planner-validation-warnings",
  ValidationRemediated:       "planner-validation-remediated",
  RuntimeCompiled:            "planner-runtime-compiled",
  OutputRootForced:           "planner-output-root-forced",
  Generating:                 "planner-generating",
  PipelineStart:              "planner-pipeline-start",
  PipelineEnd:                "planner-pipeline-end",
  BudgetExtended:             "planner-budget-extended",
  StepStart:                  "planner-step-start",
  StepEnd:                    "planner-step-end",
  StepTransition:             "planner-step-transition",
  Verification:               "planner-verification",
  VerificationFollowup:       "planner-verification-followup",
  IssueTimeline:              "planner-issue-timeline",
  RepairPlan:                 "planner-repair-plan",
  RepairCompatibility:        "planner-repair-compatibility",
  Retry:                      "planner-retry",
  RetrySkip:                  "planner-retry-skip",
  RetryAbort:                 "planner-retry-abort",
  Escalation:                 "planner-escalation",
  Failure:                    "planner_failure",
  PlanningPreflight:          "planning_preflight",
  DirectLoopFallback:         "direct_loop_fallback",
  TaskFailed:                 "task_failed",
  VerificationAttemptFailure: "verification_attempt_failure",
  VerifierReconciliation:     "verifier-reconciliation-check",
  VerifierContractCheck:      "verifier-contract-check",
} as const

export type PlannerTraceKind = (typeof PlannerTraceKind)[keyof typeof PlannerTraceKind]

export const PLANNER_TRACE_KINDS: ReadonlyArray<PlannerTraceKind> =
  Object.values(PlannerTraceKind)

export const isPlannerTraceKind = (value: unknown): value is PlannerTraceKind =>
  typeof value === "string" && (PLANNER_TRACE_KINDS as readonly string[]).includes(value)

// ── CoherentGenerationTraceKind (coherent-* generation pipeline) ─────────────
export const CoherentGenerationTraceKind = {
  Start:        "coherent-generation-start",
  Token:        "coherent-generation-token",
  Failed:       "coherent-generation-failed",
  Bundle:       "coherent-generation-bundle",
  Materialized: "coherent-generation-materialized",
  RepairNeeded: "coherent-generation-repair-needed",
  Handoff:      "coherent-generation-handoff",
  Verified:     "coherent-generation-verified",
  Escalated:    "coherent-generation-escalated",
} as const

export type CoherentGenerationTraceKind =
  (typeof CoherentGenerationTraceKind)[keyof typeof CoherentGenerationTraceKind]

export const COHERENT_GENERATION_TRACE_KINDS: ReadonlyArray<CoherentGenerationTraceKind> =
  Object.values(CoherentGenerationTraceKind)

export const isCoherentGenerationTraceKind = (
  value: unknown,
): value is CoherentGenerationTraceKind =>
  typeof value === "string" &&
  (COHERENT_GENERATION_TRACE_KINDS as readonly string[]).includes(value)

// ── DelegationTraceKind (subagent delegation lifecycle) ──────────────────────
export const DelegationTraceKind = {
  PlannerStart:     "planner-delegation-start",
  PlannerIteration: "planner-delegation-iteration",
  PlannerEnd:       "planner-delegation-end",
  PlannerDecision:  "planner-delegation-decision",
  Start:            "delegation-start",
  Iteration:        "delegation-iteration",
  End:              "delegation-end",
  ParallelStart:    "delegation-parallel-start",
  ParallelEnd:      "delegation-parallel-end",
} as const

export type DelegationTraceKind =
  (typeof DelegationTraceKind)[keyof typeof DelegationTraceKind]

export const DELEGATION_TRACE_KINDS: ReadonlyArray<DelegationTraceKind> =
  Object.values(DelegationTraceKind)

export const isDelegationTraceKind = (value: unknown): value is DelegationTraceKind =>
  typeof value === "string" && (DELEGATION_TRACE_KINDS as readonly string[]).includes(value)

// ── DelegationSpanEventKind (in-iteration child events) ──────────────────────
export const DelegationSpanEventKind = {
  Nudge:       "nudge",
  Thinking:    "thinking",
  LlmRequest:  "llm-request",
  LlmResponse: "llm-response",
} as const

export type DelegationSpanEventKind =
  (typeof DelegationSpanEventKind)[keyof typeof DelegationSpanEventKind]

export const DELEGATION_SPAN_EVENT_KINDS: ReadonlyArray<DelegationSpanEventKind> =
  Object.values(DelegationSpanEventKind)

export const isDelegationSpanEventKind = (value: unknown): value is DelegationSpanEventKind =>
  typeof value === "string" &&
  (DELEGATION_SPAN_EVENT_KINDS as readonly string[]).includes(value)
