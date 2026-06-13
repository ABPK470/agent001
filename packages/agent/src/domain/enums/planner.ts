/**
 * Planner enums — single source of truth for every classification the
 * planner pipeline reasons about.
 *
 * Wire enums (cross agent↔server↔UI) are owned by `@mia/shared-enums`
 * and re-exported here so existing `from "@mia/agent"` imports keep
 * working. Internal enums (no wire crossing) are declared inline below
 * using the canonical `as const` pattern:
 *   - `export const X = { Member: "literal", … } as const`
 *   - `export type X = (typeof X)[keyof typeof X]`
 *   - `export const X_VALUES = Object.values(X)`
 *   - `isX(value): value is X` runtime guard for boundary validation
 */

// ── Wire enums (canonical source: @mia/shared-enums) ──────────

export {
  DIRECT_LOOP_FALLBACK_SOURCE_VALUES,
  DirectLoopFallbackSource,
  isDirectLoopFallbackSource,
  isPlannerRoute,
  isPlannerStepPhase,
  isVerificationMode,
  isVerifierMode,
  isVerifierOutcome,
  PLANNER_ROUTE_VALUES,
  PLANNER_STEP_PHASE_VALUES,
  PlannerRoute,
  PlannerStepPhase,
  VERIFICATION_MODES,
  VerificationMode,
  VERIFIER_MODES,
  VERIFIER_OUTCOMES,
  VerifierMode,
  VerifierOutcome
} from "@mia/shared-enums"

// ── Internal enums (agent-only) ──────────────────────────────────

// ── Diagnostic classification (validation pipeline) ──────────────

export const DiagnosticCategory = {
  Parse: "parse",
  Graph: "graph",
  Contract: "contract",
  Ownership: "ownership",
  Verification: "verification",
  Policy: "policy"
} as const

export type DiagnosticCategory = (typeof DiagnosticCategory)[keyof typeof DiagnosticCategory]

export const DIAGNOSTIC_CATEGORIES: ReadonlyArray<DiagnosticCategory> = Object.values(DiagnosticCategory)

export const isDiagnosticCategory = (value: unknown): value is DiagnosticCategory =>
  typeof value === "string" && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value)

export const DiagnosticSeverity = {
  Error: "error",
  Warning: "warning"
} as const

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity]

export const DIAGNOSTIC_SEVERITIES: ReadonlyArray<DiagnosticSeverity> = Object.values(DiagnosticSeverity)

export const isDiagnosticSeverity = (value: unknown): value is DiagnosticSeverity =>
  typeof value === "string" && (DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)

// ── Pipeline execution state ─────────────────────────────────────

export const PipelineStatus = {
  Running: "running",
  Completed: "completed",
  Failed: "failed"
} as const

export type PipelineStatus = (typeof PipelineStatus)[keyof typeof PipelineStatus]

export const PIPELINE_STATUSES: ReadonlyArray<PipelineStatus> = Object.values(PipelineStatus)

export const isPipelineStatus = (value: unknown): value is PipelineStatus =>
  typeof value === "string" && (PIPELINE_STATUSES as readonly string[]).includes(value)

// ── Step execution roles ─────────────────────────────────────────

export const StepRole = {
  Writer: "writer",
  Reviewer: "reviewer",
  Validator: "validator",
  Grounding: "grounding"
} as const

export type StepRole = (typeof StepRole)[keyof typeof StepRole]

export const STEP_ROLES: ReadonlyArray<StepRole> = Object.values(StepRole)

export const isStepRole = (value: unknown): value is StepRole =>
  typeof value === "string" && (STEP_ROLES as readonly string[]).includes(value)

// ── Verifier issue severities (internal) ────────────────────────

export const VerifierIssueSeverity = {
  Warning: "warning",
  Error: "error",
  Fatal: "fatal"
} as const

export type VerifierIssueSeverity = (typeof VerifierIssueSeverity)[keyof typeof VerifierIssueSeverity]

export const VERIFIER_ISSUE_SEVERITIES: ReadonlyArray<VerifierIssueSeverity> =
  Object.values(VerifierIssueSeverity)

export const isVerifierIssueSeverity = (value: unknown): value is VerifierIssueSeverity =>
  typeof value === "string" && (VERIFIER_ISSUE_SEVERITIES as readonly string[]).includes(value)

// ── Verifier evidence source ─────────────────────────────────────

export const VerifierEvidenceSource = {
  Contract: "contract",
  Deterministic: "deterministic",
  Llm: "llm"
} as const

export type VerifierEvidenceSource = (typeof VerifierEvidenceSource)[keyof typeof VerifierEvidenceSource]

export const VERIFIER_EVIDENCE_SOURCES: ReadonlyArray<VerifierEvidenceSource> =
  Object.values(VerifierEvidenceSource)

export const isVerifierEvidenceSource = (value: unknown): value is VerifierEvidenceSource =>
  typeof value === "string" && (VERIFIER_EVIDENCE_SOURCES as readonly string[]).includes(value)

// ── Pipeline reconciliation findings (block codes) ───────────────
//
// Codes returned by the post-execution contract reconciliation that
// summarise *why* a step's output failed contract compliance.
export const PipelineBlockCode = {
  ForbiddenArtifactWrite: "forbidden_artifact_write",
  MissingRequiredOutput: "missing_required_output",
  HallucinatedArtifact: "hallucinated_artifact",
  UnresolvedBlocker: "unresolved_blocker",
  RequiredCheckSkipped: "required_check_skipped"
} as const

export type PipelineBlockCode = (typeof PipelineBlockCode)[keyof typeof PipelineBlockCode]

export const PIPELINE_BLOCK_CODES: ReadonlyArray<PipelineBlockCode> = Object.values(PipelineBlockCode)

export const isPipelineBlockCode = (value: unknown): value is PipelineBlockCode =>
  typeof value === "string" && (PIPELINE_BLOCK_CODES as readonly string[]).includes(value)
