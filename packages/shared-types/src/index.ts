/**
 * Shared frontend types — mirrors the server API contract.
 *
 * Wire enums are imported from `@mia/shared-enums` (single source of
 * truth across agent/server/UI). Never declare a parallel `"a" | "b"`
 * union for a value set that already exists in shared-enums — import
 * the type instead so renames flow automatically.
 */

import type {
    DecompositionStrategy,
    DelegationEndStatus,
    DirectLoopFallbackSource,
    EffectClass,
    EscalationAction,
    EscalationReason,
    EventType,
    PlannerNeedLevel,
    PlannerRepairActivePath,
    PlannerRepairCompatibilityMode,
    PlannerRoute,
    PlannerStepPhase,
    PolicySource,
    VerificationMode,
    VerifierMode,
    VerifierOutcome,
} from "@mia/shared-enums"

export type {
    DecompositionStrategy,
    DelegationEndStatus,
    DirectLoopFallbackSource,
    EffectClass,
    EscalationAction,
    EscalationReason,
    EventType,
    PlannerNeedLevel,
    PlannerRepairActivePath,
    PlannerRepairCompatibilityMode,
    PlannerRoute,
    PlannerStepPhase,
    VerificationMode,
    VerifierMode,
    VerifierOutcome
}


// ── Run ──────────────────────────────────────────────────────────

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  parentRunId: string | null
  agentId: string | null
  createdAt: string
  completedAt: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
  pendingWorkspaceChanges?: number
  /** Owner UPN — present when the server returns all runs (e.g. admin scope). */
  upn?: string | null
  /** Owner display name — present alongside upn for admin-scope responses. */
  displayName?: string | null
  trace?: TraceEntry[]
  streamingAnswer?: string
  coherentStream?: string
  auditTrail?: AuditEntry[]
  stepData?: Step[]
}

export interface RunDetail extends Run {
  /**
   * Legacy slot. The schema redesign (v14) dropped the runs.data column;
   * the server no longer ships steps in this field. Steps are now
   * reconstructed from the trace stream (see `tracesToSteps` in store.ts).
   * Kept optional so older shapes still typecheck.
   */
  data?: {
    steps?: Step[]
    [key: string]: unknown
  }
  audit: AuditEntry[]
  logs: LogEntry[]
  hasCheckpoint: boolean
}

export interface WorkspaceDiff {
  runId: string
  added: string[]
  modified: string[]
  deleted: string[]
  total: number
  /** Source workspace root where changes will be applied. */
  sourceRoot?: string
  /** Isolated run workspace root where the generated files currently live. */
  executionRoot?: string
}

export interface WorkspaceDiffApplyResult {
  ok: boolean
  runId: string
  applied: {
    added: number
    modified: number
    deleted: number
  }
}

// ── Step ─────────────────────────────────────────────────────────

export interface Step {
  id: string
  name: string
  action: string
  status: string
  order: number
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

// ── Audit ────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  timestamp: string
}

// ── Inter-agent bus message (Phase B) ────────────────────────────

/**
 * Snapshot of an inter-agent bus message as observed by the UI.
 * Mirrors the SSE payload emitted by `AgentBus.emitSse` and the row
 * shape from `agent_messages`. The `protocol` field is a free string
 * here (rather than the closed enum) so the UI can tolerate forward
 * compatibility — unknown protocols just render as their string.
 */
export interface BusMessage {
  /** Server-assigned message id; stable for reply_to / wait_for_response. */
  id: string
  /** Root run id (the run tree this message belongs to). */
  runId: string
  /** Free-form domain channel — e.g. "research-results". */
  topic: string
  /** Coordination intent: status | result | help | question | answer | broadcast. */
  protocol: string
  /** Run id of the publisher (a child run within the same root). */
  fromRunId: string
  /** Display name of the publishing agent. */
  fromAgent: string
  /** Message body. */
  content: string
  /** id of the message this is replying to, when protocol === "answer". */
  replyTo: string | null
  /** Wall-clock time the message was persisted (ms epoch). */
  timestamp: number
}

// ── Log ──────────────────────────────────────────────────────────

export interface LogEntry {
  /** Event group: run, step, sync, agent, api, system. */
  type: string
  /** true for failed / killed / cancelled events — drives red highlighting. */
  error?: boolean
  message: string
  timestamp: string
  /** Original SSE event name — e.g. "run.started", "sync.preview.sql". */
  eventName?: string
  /** Raw event payload — all fields from the SSE event. */
  data?: Record<string, unknown>
}

// ── Trace (rich agent execution trace) ───────────────────────────

export type TraceEntry =
  | { kind: "goal"; text: string }
  | { kind: "iteration"; current: number; max: number }
  | { kind: "thinking"; text: string }
  | { kind: "tool-call"; invocationId: string; toolCallId?: string | null; tool: string; argsSummary: string; argsFormatted: string }
  | { kind: "tool-result"; invocationId?: string; toolCallId?: string | null; text: string }
  | { kind: "tool-error"; invocationId?: string; toolCallId?: string | null; text: string }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string }
  | { kind: "usage"; iterationTokens: number; totalTokens: number; promptTokens: number; completionTokens: number; llmCalls: number }
  | { kind: "delegation-start"; goal: string; depth: number; tools: string[]; agentId?: string; agentName?: string }
  | { kind: "delegation-iteration"; depth: number; iteration: number; maxIterations: number }
  | { kind: "delegation-end"; depth: number; status: DelegationEndStatus; answer?: string; error?: string }
  | { kind: "delegation-parallel-start"; depth: number; taskCount: number; goals: string[] }
  | { kind: "delegation-parallel-end"; depth: number; taskCount: number; fulfilled: number; rejected: number }
  | { kind: "user-input-request"; question: string; options?: string[]; sensitive?: boolean }
  | { kind: "user-input-response"; text: string }
  // Planner entries (agenc-core planner-first routing)
  | { kind: "planning_preflight"; mode: "planner-first" }
  | { kind: "planner-decision"; score: number; shouldPlan: boolean; route?: PlannerRoute; reason: string; coherenceNeed?: PlannerNeedLevel; coordinationNeed?: PlannerNeedLevel }
  | { kind: "coherent-generation-start"; route: "bounded_coherent_generation" }
  | { kind: "coherent-generation-bundle"; artifactCount: number; artifacts: Array<{ path: string; purpose: string }>; sharedContracts: string[]; invariants: string[] }
  | { kind: "coherent-generation-materialized"; artifactCount: number; artifacts: string[]; readBackArtifacts: string[] }
  | { kind: "coherent-generation-verified"; overall: VerifierOutcome; confidence: number; issueCount: number; systemCheckCount: number; affectedArtifacts: string[] }
  | { kind: "coherent-generation-repair-needed"; repairAttempt: number; issueCount: number; issues: string[]; affectedArtifacts: string[] }
  | { kind: "coherent-generation-escalated"; target: string; issueCount: number; reason: string }
  | { kind: "coherent-generation-handoff"; artifactCount: number; verificationRoute: string }
  | { kind: "coherent-generation-failed"; stage: string; diagnostics: string[] }
  | { kind: "planner-coherent-bootstrap"; artifactCount: number; decompositionStrategy: DecompositionStrategy; decompositionReasons: string[]; sharedContracts: string[]; invariants: string[] }
  | { kind: "planner-architecture-state"; lane: PlannerRoute; status: "frozen" | "preserved" | "repairing_in_place" | "abandoned"; reason: string; architecture?: string }
  | { kind: "planner-generating" }
  | { kind: "planner-plan-generated"; reason: string; stepCount: number; steps: Array<{ name: string; type: string; dependsOn?: string[] }>; edges?: Array<{ from: string; to: string }> }
  | {
    kind: "planner-runtime-compiled"
    executionSteps: Array<{ stepName: string; dependsOn: string[]; downstream: string[] }>
    ownershipArtifacts: Array<{ artifactPath: string; ownerStepName: string | null; consumerStepNames: string[] }>
    runtimeEntities: Array<{ id: string; entityType: string; parentId?: string; stepName?: string }>
  }
  | { kind: "planner-generation-failed"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-output-root-forced"; outputRoot: string }
  | { kind: "planner-validation-failed"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-validation-remediated"; diagnostics: Array<{ code: string; message: string }> }
  | { kind: "planner-validation-warnings"; warningCount: number; diagnostics: Array<{ code: string; message: string }> }
  | {
    kind: "planner-sql-quality"
    toolCallId: string
    toolName: string
    iteration: number
    toolMode: "query" | "export"
    phase: "blocked" | "executed" | "failed"
    connection: string
    database: string | null
    validationOk: boolean
    validationCode: string | null
    largeObjectRefs: Array<{ name: string; count: number }>
    usesPersistedMirrors: string[]
    missingPersistedMirrorCandidates: string[]
    hasWhereClause: boolean
    unsafeScanReason: string | null
    tempTableRefs: number
    tempTablesCreated: number
    tempTableSuffixes: string[]
    malformedTempSuffixes: string[]
    missingTempCreations: string[]
    aggregateWarningCount: number
    aggregateBlockCount: number
    tempScalarSubqueryCount: number
    stagePatternLikely: boolean
    durationMs: number | null
    rowCount: number | null
    error: string | null
    sqlPreview: string
    sqlLength: number
    /**
     * Active doctrine module versions at trace-emission time. Lets downstream
     * tooling correlate a run with the exact policy bodies in force. Optional
     * for backwards compatibility with traces emitted before the registry shipped.
     */
    doctrineVersions?: Record<string, string>
  }
  | {
    /**
     * Phase 6 telemetry: per-iteration prompt budget allocation snapshot.
     * Emitted once per agent iteration when the budget actually constrained
     * the prompt (drops, truncations, or hard cap reached). Lets the
     * dashboard track p95 prompt size and flag section-over-injection.
     */
    kind: "planner-prompt-budget"
    iteration: number
    model: string | null
    totalBeforeChars: number
    totalAfterChars: number
    totalChars: number
    constrained: boolean
    droppedSections: string[]
    /** Per-section bytes after allocation. Keys are PromptBudgetSection strings. */
    sectionAfterChars: Record<string, number>
    /** Per-section message count after allocation. */
    sectionAfterMessages: Record<string, number>
    /** Per-section messages truncated (content-only truncation, not drop). */
    sectionTruncatedMessages: Record<string, number>
  }
  | { kind: "direct_loop_fallback"; source: DirectLoopFallbackSource; reason: string }
  | { kind: "planner-pipeline-start"; attempt: number; verifierRound?: number; maxRetries: number }
  | { kind: "planner-pipeline-end"; status: string; completedSteps: number; totalSteps: number }
  | { kind: "planner-step-start"; stepName: string; stepType: string }
  | { kind: "planner-step-transition"; attempt: number; stepName: string; phase: PlannerStepPhase; state: string; timestamp: number }
  | {
    kind: "planner-step-end"
    stepName: string
    status: string
    executionState?: string
    acceptanceState?: string
    durationMs: number
    error?: string
    validationCode?: string
    producedArtifacts?: string[]
    verificationAttempts?: Array<{ toolName: string; target?: string; success: boolean; summary: string }>
    reconciliation?: { compliant: boolean; findings: Array<{ code: string; severity: string; message: string }> }
  }
  | {
    kind: "planner-verification"
    overall: string
    confidence: number
    verifierRound?: number
    systemChecks?: Array<{ code: string; severity: string; summary: string; confidence: number }>
    steps: Array<{ stepName: string; outcome: string; issues: string[]; issueCodes?: string[]; acceptanceState?: string; ownershipModes?: string[]; issueConfidences?: number[] }>
  }
  | {
    kind: "planner-verification-followup"
    requestedSteps: string[]
    reasons: Array<{ stepName: string; confidence: number; ambiguousIssues: string[] }>
  }
  | {
    kind: "planner-issue-timeline"
    attempt: number
    verifierRound: number
    issues: Array<{ stepName: string; code: string; confidence: number; ownershipMode: string; primaryOwner?: string; suspectedOwners: string[] }>
  }
  | {
    kind: "planner-repair-plan"
    attempt: number
    epoch?: number
    rerunOrder: string[]
    tasks: Array<{ stepName: string; mode: VerifierMode; ownedIssueCodes: string[]; dependencyIssueCodes: string[] }>
  }
  | {
    kind: "planner-repair-compatibility"
    attempt: number
    mode: PlannerRepairCompatibilityMode
    activePath: PlannerRepairActivePath
    diverged: boolean
    divergenceScore?: number
    divergenceThreshold?: number
    pinnedToLegacy?: boolean
    reasons: string[]
    legacy: { rerunOrder: string[]; tasks: Array<{ stepName: string; mode: VerifierMode; ownedIssueCodes: string[] }> }
    repair: { rerunOrder: string[]; tasks: Array<{ stepName: string; mode: VerifierMode; ownedIssueCodes: string[]; dependencyIssueCodes: string[] }> }
  }
  | { kind: "planner-retry"; attempt: number; reason: string; skippedSteps?: number; retrySteps?: number; rerunOrder?: string[] }
  | { kind: "planner-retry-skipped"; reason: string }
  // Delegation decision gate (safety, economics, hard-block)
  | { kind: "planner-delegation-decision"; shouldDelegate: boolean; reason: string; utilityScore: number; safetyRisk: number; confidence: number; hardBlockedTaskClass: string | null }
  // Pipeline budget extension (planner/circuit-breaker)
  | { kind: "planner-budget-extended"; completedSteps: number; effectiveBudget: number; extensions: number }
  // Escalation graph
  | { kind: "planner-escalation"; action: EscalationAction; reason: EscalationReason; attempt: number }
  // Retry abort (all steps stuck)
  | { kind: "planner-retry-abort"; reason: string }
  // Per-step retry skip (repeated failure / stub regression)
  | { kind: "planner-retry-skip"; stepName: string; reason: string }
  // Planner delegation entries (child agents spawned by planner)
  | {
    kind: "planner-delegation-start"
    goal: string
    stepName: string
    depth: number
    tools: string[]
    budget: {
      hint: string
      parsedHint: number
      baseBudget: number
      contractFloor: number
      complexityBoost: number
      computedMaxIterations: number
      targetArtifactCount: number
      requiredSourceArtifactCount: number
      acceptanceCriteriaCount: number
      codeArtifactCount: number
      hasComplexImplementation: boolean
      hasBlueprintSource: boolean
      verificationMode: VerificationMode
    }
    envelope: { workspaceRoot?: string; effectClass?: EffectClass; verificationMode?: VerificationMode; targetArtifacts?: string[] }
  }
  | { kind: "planner-delegation-iteration"; stepName: string; depth: number; iteration: number; maxIterations: number }
  | { kind: "planner-delegation-end"; stepName: string; depth: number; status: DelegationEndStatus; answer?: string; error?: string }
  // Debug/inspector entries
  | { kind: "system-prompt"; text: string }
  | { kind: "tools-resolved"; tools: Array<{ name: string; description: string; parameters?: Record<string, unknown> }> }
  | { kind: "tools-filtered"; dropped: string[]; kept: number; dbScore: number; syncTrigger: boolean; reason: string }
  | { kind: "nudge"; tag: string; message: string; iteration: number }
  | { kind: "llm-request"; iteration: number; messageCount: number; toolCount: number; messages: Array<{ role: string; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; toolCallId: string | null }> }
  | { kind: "llm-response"; iteration: number; durationMs: number; content: string | null; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }
  | { kind: "workspace_diff"; diff: { added: readonly string[]; modified: readonly string[]; deleted: readonly string[] } }
  | { kind: "workspace_diff_applied"; summary: { added: number; modified: number; deleted: number } }

// ── Layout ───────────────────────────────────────────────────────

export interface SavedLayout {
  id: string
  name: string
  config: ViewConfig
  updatedAt: string
}

// ── Dashboard ────────────────────────────────────────────────────

export interface Widget {
  id: string
  type: WidgetType
}

export type WidgetType =
  | "agent-chat"
  | "term-chat"
  | "run-status"
  | "agent-viz"
  | "live-logs"
  | "audit-trail"
  | "step-timeline"
  | "tool-stats"
  | "run-history"
  | "operator-env"
  | "debug-inspector"
  | "mymi-db"
  | "active-users"
  | "env-sync"
  | "operation-log"
  | "entity-registry"
  | "scd2-strategies"
  | "freeze-windows"
  | "sync-proposals"
  | "sync-approvals"
  | "sync-evidence"
  | "sync-admin"

/**
 * Widget types visible AND interactive for non-admin "visitor" users.
 * Other widgets still appear in the catalogue (so visitors see what
 * exists) but are rendered as disabled cards. Admins get the full set.
 */
export const VISITOR_WIDGETS: ReadonlySet<WidgetType> = new Set([
  "term-chat",
  "env-sync",
  "live-logs",
  "operation-log",
  "mymi-db",
  "run-history",
  "operator-env",
])

export interface ViewConfig {
  id: string
  name: string
  widgets: Widget[]
  layouts: Record<string, LayoutItem[]>
}

export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

// ── SSE events ────────────────────────────────────────────────────────

/**
 * Wire envelope for every event sent over the SSE bus and persisted to
 * the events table. The discriminator (`type`) is the canonical
 * `EventType` enum from `@mia/shared-enums` — every server emit site
 * and UI receive site narrows on it for exhaustiveness.
 */
export interface SseEvent {
  type: EventType
  data: Record<string, unknown>
  timestamp: string
}

// ── ABI Environment Sync ─────────────────────────────────────────

/**
 * Identifier for a sync entity (e.g. "contract", "dataset", "rule",
 * "pipelineActivity", "gateMetadata", "content" — or any tenant-defined
 * id from the entity registry).
 *
 * Historically this was a compile-time string union; Phase 0 lifts it to
 * a plain string to let the registry add new entities at runtime without
 * a code change. Validation against the registered set happens at the
 * boundaries (route handlers + orchestrator).
 */
export type SyncEntityType = string

export interface SyncEnvironment {
  name: string
  displayName: string
  color: string
  role: "source" | "target" | "both"
  ringOrder: number
  syncAllowlist: string[]
  allowedSyncTargets: string[] | null
}

export interface SyncRecipeTable {
  name: string
  scopeColumn: string | null
  predicate: string
  source: "fk+pipeline" | "fk-only" | "pipeline-only"
  verified: boolean
  groundedByPipeline?: boolean
  enabledByDefault?: boolean
  userControllable?: boolean
  note?: string
}

export interface SyncRecipe {
  entityType: SyncEntityType
  displayName: string
  rootTable: string
  rootKeyColumn: string
  rootNameColumn: string | null
  legacyPipelineId: number | null
  legacyEntrySproc?: string
  tables: SyncRecipeTable[]
  executionOrder: string[]
  reverseOrder: string[]
  discrepancies: Array<{ table: string; kind: "leak" | "implicit" | "drift"; note: string }>
  generatedAt: string
}

export interface SyncRecipeBundle {
  version: 1
  generatedAt: string
  introspectedFrom: string | null
  recipes: Record<SyncEntityType, SyncRecipe | null>
}

export interface SyncPlanTableCounts {
  insert: number
  update: number
  delete: number
  unchanged: number
  lowConfidence: number
  conflicts: number
}

export interface SyncPlanConflict {
  pk: unknown
  expectedScope: unknown
  actualScope: unknown
  summary: string
}

export interface SyncPlanRowSample {
  values?: Record<string, unknown>
  newValues?: Record<string, unknown>
  oldValues?: Record<string, unknown>
  changedColumns?: string[]
}

export interface SyncPlanTable {
  table: string
  scopePredicate: string
  counts: SyncPlanTableCounts
  samples: {
    insert: SyncPlanRowSample[]
    update: SyncPlanRowSample[]
    delete: SyncPlanRowSample[]
  }
  conflicts: SyncPlanConflict[]
  warnings: string[]
  diffDurationMs: number
}

export interface SyncPlanGraph {
  nodes: Array<{ id: string; label: string; status: "unchanged" | "updates" | "deletes" | "inserts"; counts: SyncPlanTableCounts }>
  edges: Array<{ from: string; to: string; label?: string }>
}

export interface SyncPlanTotals {
  insert: number
  update: number
  delete: number
  unchanged: number
  lowConfidence: number
  conflicts: number
  tablesCount: number
}

export interface SyncPlan {
  planId: string
  createdAt: string
  createdAtMs: number
  entity: { type: SyncEntityType; id: string | number; displayName: string | null }
  source: string
  target: string
  preflight: { catalogCompatible: boolean; issues: string[] }
  tables: SyncPlanTable[]
  totals: SyncPlanTotals
  dependencyGraph: SyncPlanGraph
  warnings: string[]
  estimatedDurationSec: number
  recipeSnapshot: { entityType: SyncEntityType; rootTable?: string; rootKeyColumn?: string; legacyPipelineId?: number; tables: Array<{ name: string; scopeColumn: string | null; predicate: string }>; executionOrder: string[]; reverseOrder: string[]; enabledOptionalTables?: string[] }
  executionContract?: CompiledSyncPlanContract | null
  decisionLog?: CompiledSyncDecisionRecord[] | null
  governanceDecision?: CompiledSyncGovernanceDecision | null
}

export type AuthoredSyncFlowPhase =
  | "pre-transaction"
  | "metadata"
  | "post-metadata"
  | "post-commit"

export type AuthoredSyncFlowKind =
  | "metadataSync"
  | "auditCheck"
  | "targetLock"
  | "targetUnlock"
  | "contractUndeploy"
  | "contractPreScript"
  | "contractCreateStageDataset"
  | "contractCreateArchiveDataset"
  | "contractCreateListDataset"
  | "contractCreateDimDataset"
  | "contractCreateFactDataset"
  | "contractCreateDatasetFks"
  | "contractDeployEtl"
  | "contractDeployRoutine"
  | "contractPostScript"
  | "datasetDeploy"
  | "rulesDeploy"
  | "pipelineRegister"
  | "metaRefresh"
  | "pipelineStart"
  | "handleDependencies"
  | "syncDate"
  | "deployDate"

export interface AuthoredSyncDefinitionGovernance {
  freezeWindowIds: string[]
  riskMultiplier: number
}

export interface AuthoredSyncDefinitionStrategyRef {
  strategyId: string
  strategyVersion: number | "latest"
}

export interface AuthoredSyncDefinitionBindingRefs {
  serviceProfileRef: string
  environmentPolicyRef: string
}

export interface AuthoredSyncDefinitionOwnership {
  team: string
  owner: string | null
  reviewStatus: "legacy-review-required" | "reviewed"
  notes: string[]
}

export interface AuthoredSyncFlowStep {
  id: string
  phase: AuthoredSyncFlowPhase
  kind: AuthoredSyncFlowKind
  title: string
  description: string
  subjectRef?: "entityId" | "ruleInputDatasetId" | "contractPipelineId" | null
  objectName?: string | null
  auditObjectType?: string | null
  pipelineName?: string | null
}

export interface AuthoredSyncDefinitionTable {
  name: string
  scopeColumn: string | null
  predicate: string
  source: "fk+pipeline" | "fk-only" | "pipeline-only" | "manual"
  verified: boolean
  groundedByPipeline: boolean
  enabledByDefault: boolean
  userControllable: boolean
  note?: string
}

export interface AuthoredSyncDefinitionDiscrepancy {
  table: string
  kind: "leak" | "implicit" | "drift"
  note: string
}

export interface AuthoredSyncDefinition {
  schemaVersion: 1
  id: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn: string | null
  legacy: {
    pipelineId: number | null
    entrySproc: string | null
  }
  governance: AuthoredSyncDefinitionGovernance
  strategy: AuthoredSyncDefinitionStrategyRef
  bindings: AuthoredSyncDefinitionBindingRefs
  ownership: AuthoredSyncDefinitionOwnership
  metadata: {
    tables: AuthoredSyncDefinitionTable[]
    executionOrder: string[]
    reverseOrder: string[]
    discrepancies: AuthoredSyncDefinitionDiscrepancy[]
  }
  executionFlow: {
    steps: AuthoredSyncFlowStep[]
  }
  provenance: {
    kind: "manual" | "legacy-migration"
    sourceArtifact?: string | null
    sourceVersion?: string | null
  }
}

export interface PublishedSyncDefinition extends AuthoredSyncDefinition {
  publishedAt: string
  publishedVersion: string
}

export interface PublishSyncDefinitionsResponse {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  publishedBundlePath: string
  stdout: string[]
  stderr: string[]
}

export type SyncDefinitionFlowPreset =
  | "contract"
  | "dataset"
  | "rule"
  | "pipelineActivity"
  | "gateMetadata"
  | "content"
  | "metadata-only"

export interface EntityRegistrySyncDefinitionScaffoldRequest {
  flowPreset?: SyncDefinitionFlowPreset
  serviceProfileRef?: string
  environmentPolicyRef?: string
}

export interface EntityRegistrySyncDefinitionScaffoldResponse {
  suggestedPath: string
  definition: AuthoredSyncDefinition
  stderr: string[]
}

export interface CompiledSyncPlanStep {
  id: string
  phase: AuthoredSyncFlowPhase
  kind: AuthoredSyncFlowKind
  title: string
  description: string
  subjectRef?: "entityId" | "ruleInputDatasetId" | "contractPipelineId" | null
  objectName?: string | null
  auditObjectType?: string | null
  pipelineName?: string | null
}

export interface CompiledSyncPlanContract {
  definitionId: string
  definitionVersion: string
  steps: CompiledSyncPlanStep[]
  governance: AuthoredSyncDefinitionGovernance
  bindings: AuthoredSyncDefinitionBindingRefs
  allowedSchemas: string[]
}

export interface CompiledSyncGovernanceDecision {
  evaluatedAt: string
  governance: AuthoredSyncDefinitionGovernance
  freezeWindows: {
    active: boolean
    activeWindows: Array<{ id: string; displayName: string; startsAt: string; endsAt: string }>
    unknownIds: string[]
  }
  targetEnvironment: {
    name: string
    role: string
    prodSyncUnlocked: boolean
    syncAllowlistEnabled: boolean
    actorUpn: string | null
    actorAllowed: boolean | null
  }
  warnings: string[]
}

export interface CompiledSyncDecisionRecord {
  id: string
  recordedAt: string
  stage: "preview" | "execute"
  category: "definition" | "flow" | "scope" | "preflight" | "governance" | "execution"
  severity: "info" | "warning" | "error"
  title: string
  summary: string
  details: Record<string, unknown>
}

export interface SyncExecuteProgress {
  type: "started" | "step" | "table-started" | "table-progress" | "table-done" | "completed" | "failed"
  table?: string
  step?: string
  rowsApplied?: number
  rowsTotal?: number
  message?: string
  error?: string
}

// ── Entity registry (Phase 0 config uplift) ──────────────────────
//
// Wire shape for the entity registry's REST + SSE surface. The full
// in-memory shape (with discriminated `scope.kind`, override semantics,
// validation codes, etc.) lives in `@mia/agent` — these DTOs are just
// JSON-stable mirrors used by the UI store and route bodies.

export type EntityRegistryProvenanceKind = "bundled" | "imported" | "manual" | "agent"

export type EntityRegistryTableScope =
  | { kind: "rootPk"; column: string }
  | { kind: "fkPath"; through: Array<{ table: string; fromColumn: string; toColumn: string }> }
  | { kind: "sql"; predicate: string }

export type EntityRegistryProvenance =
  | { kind: "manual" }
  | { kind: "bundled" }
  | { kind: "agent"; runId?: string | null }
  | { kind: "imported"; sourceManifestId?: string; source?: string }
  | { kind: "template"; templateId: string; templateVersion?: number; entityId?: string }
  | { kind: "legacy-migration"; legacyPipelineId: number | null }

export interface EntityRegistryTable {
  name: string
  scope: EntityRegistryTableScope
  executionOrder: number
  scd2Override: EntityRegistryScd2Override | null
  verified: boolean
  archiveTable: string | null
  note: string | null
  provenance: EntityRegistryProvenance
  scopeColumn: string | null
  source: "fk+pipeline" | "fk-only" | "pipeline-only" | "manual" | null
  groundedByPipeline: boolean | null
  enabledByDefault: boolean | null
  userControllable: boolean | null
}

export interface EntityRegistryPolicies {
  freezeWindowIds: string[]
  riskMultiplier: number
}

export interface EntityRegistryLineageRef {
  object: string
  kind: "view-source" | "report-source" | "downstream-consumer"
  note: string | null
}

export interface EntityRegistryScd2Override {
  validFromCol?: string | null
  validToCol?: string | null
  isLockedCol?: string | null
  syncDateCol?: string | null
  deployDateCol?: string | null
  identityHandling?: "none" | "setIdentityInsertOn" | "preserveSequence"
  excludedFromDiffCols?: string[]
  onInsert?: Record<string, string>
  onUpdate?: Record<string, string>
}

export interface EntityRegistryStrategyRef {
  strategyId: string
  strategyVersion: number | "latest"
  entityOverride: EntityRegistryScd2Override | null
}

export interface EntityRegistryDefinition {
  id: string
  tenantId: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn: string | null
  tables: EntityRegistryTable[]
  policies: EntityRegistryPolicies
  scd2: EntityRegistryStrategyRef
  lineageRefs: EntityRegistryLineageRef[]
  provenance: EntityRegistryProvenance
  // Enriched (additive)
  legacyEntrySproc: string | null
  reverseOrder: string[]
  discrepancies: string[]
  version: number
  versionLabel: string | null
  createdBy: string
  reason: string
  createdAt: string
  retiredAt: string | null
}

export interface EntityRegistryStrategy {
  id: string
  displayName: string
  description: string
  validFromCol: string | null
  validToCol: string | null
  isLockedCol: string | null
  syncDateCol: string | null
  deployDateCol: string | null
  identityHandling: "none" | "setIdentityInsertOn" | "skipIdentityCols"
  excludedFromDiffCols: string[]
  onInsert: Record<string, string>
  onUpdate: Record<string, string>
  provenance: EntityRegistryProvenance
  version: number
  versionLabel: string | null
  createdBy: string
  createdAt: string
}

export interface EntityRegistryValidationIssue {
  path: string
  code: string
  message: string
  hint?: string
}

export interface EntityRegistryValidationWarning {
  path: string
  code: string
  message: string
}

export interface EntityRegistryValidationResult {
  ok: boolean
  errors: EntityRegistryValidationIssue[]
  warnings: EntityRegistryValidationWarning[]
}

export type EntityRegistryChangeKind =
  | "created" | "renamed" | "rootTableChanged" | "idColumnChanged"
  | "scd2StrategyChanged" | "scd2OverrideChanged"
  | "tableAdded" | "tableRemoved" | "tableReordered"
  | "scopeChanged" | "verifiedFlagChanged"
  | "policiesChanged" | "lineageChanged"
  | "retired" | "unretired"

export interface EntityRegistryChange {
  kind: EntityRegistryChangeKind
  tableName: string | null
  description: string
  before?: unknown
  after?: unknown
}

export interface EntityRegistryHistoryEntry {
  tenantId: string
  id: string
  version: number
  versionLabel: string | null
  createdBy: string
  createdAt: string
  reason: string
  diff: EntityRegistryChange[]
}

export interface EntityRegistrySaveRequest {
  def: EntityRegistryDefinition
  reason: string
  versionLabel?: string | null
}

export interface EntityRegistrySaveResponse {
  tenantId: string
  id: string
  version: number
  diff: EntityRegistryChange[]
}

export interface EntityRegistryStrategySaveRequest {
  strategy: EntityRegistryStrategy
  reason: string
}

export interface EntityRegistryYamlImportRequest {
  yaml: string
  reason: string
  /** When true the server validates + diffs but does NOT persist. */
  dryRun?: boolean
}

export type EntityRegistryImportFormat = "yaml" | "json"

export interface EntityRegistryDocumentImportRequest {
  content: string
  format: EntityRegistryImportFormat
  reason: string
  /** When true the server validates + diffs but does NOT persist. */
  dryRun?: boolean
}

export interface EntityRegistryYamlImportResponse {
  ok: boolean
  saved: Array<{ id: string; version: number; created: boolean }>
  skipped: Array<{ id: string; reason: string }>
  errors: Array<{ id: string | null; error: EntityRegistryValidationResult | string }>
  dryRun: boolean
}

export type EntityRegistrySyncFlowPreset =
  | "contract"
  | "dataset"
  | "rule"
  | "pipelineActivity"
  | "gateMetadata"
  | "content"
  | "metadata-only"

export interface SyncDefinitionRuntimeOption<T extends string = string> {
  id: T
  label: string
  description?: string | null
}

export interface SyncDefinitionRuntimeOptions {
  flowPresets: SyncDefinitionRuntimeOption<EntityRegistrySyncFlowPreset>[]
  flowPresetTemplates: Record<EntityRegistrySyncFlowPreset, AuthoredSyncFlowStep[]>
  serviceProfiles: SyncDefinitionRuntimeOption[]
  environmentPolicies: SyncDefinitionRuntimeOption[]
}

export interface EntityRegistrySyncDefinitionExportRequest {
  flowPreset?: EntityRegistrySyncFlowPreset
  serviceProfileRef?: string
  environmentPolicyRef?: string
}

export interface EntityRegistrySyncDefinitionStatusLayer {
  id: "compatibility-recipe-export" | "entity-registry-projector" | "entity-registry-yaml-bootstrap"
  title: string
  runtimeAuthority: boolean
  status: "migration" | "cleanup-required"
  description: string
}

export interface EntityRegistrySyncDefinitionStatusItem {
  id: string
  displayName: string
  definitionPath: string
  provenanceKind: "manual" | "legacy-migration"
  ownershipTeam: string
  ownershipOwner: string | null
  reviewStatus: "legacy-review-required" | "reviewed"
  sourceArtifact: string | null
  sourceVersion: string | null
  unverifiedTableCount: number
  cleanupWarnings: string[]
}

export interface EntityRegistrySyncDefinitionStatusResponse {
  runtimeAuthority: {
    sourceDirectory: string
    publishedBundlePath: string
    compatibilityExportPath: string
  }
  draftExport: {
    route: string
    defaultOutputDirectory: string
    supportedFlowPresets: EntityRegistrySyncFlowPreset[]
  }
  compatibilityLayers: EntityRegistrySyncDefinitionStatusLayer[]
  definitions: EntityRegistrySyncDefinitionStatusItem[]
}

export interface EntityRegistrySyncDefinitionExportResponse {
  tenantId: string
  entityId: string
  outputPath: string
  flowPreset: EntityRegistrySyncFlowPreset
  warnings: string[]
  draft: AuthoredSyncDefinition
  status: EntityRegistrySyncDefinitionStatusItem | null
}

// ── Freeze windows (governance) ─────────────────────────────────

/**
 * Tenant-scoped scheduled blackout window. Entities reference these by
 * id via `EntityRegistryPolicies.freezeWindowIds[]`. Evaluator semantics
 * are `[startsAt, endsAt)` (start inclusive, end exclusive, ISO-8601).
 */
export interface FreezeWindow {
  tenantId:    string
  id:          string
  displayName: string
  description: string
  /** ISO-8601 inclusive start. */
  startsAt:    string
  /** ISO-8601 exclusive end. */
  endsAt:      string
  createdBy:   string
  createdAt:   string
  updatedAt:   string
}

export interface FreezeWindowSaveRequest {
  id:          string
  displayName: string
  description: string
  startsAt:    string
  endsAt:      string
}

export interface FreezeWindowListResponse {
  tenantId: string
  items:    FreezeWindow[]
}

// ── Agent Definitions ────────────────────────────────────────────

export interface AgentDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  createdAt: string
  updatedAt: string
}

export interface ToolInfo {
  name: string
  description: string
}

// ── Policy ───────────────────────────────────────────────────────

export { PolicySource } from "@mia/shared-enums"

export interface PolicyRule {
  name: string
  effect: "allow" | "require_approval" | "deny"
  condition: string
  parameters: Record<string, unknown>
  source?: PolicySource
  createdAt: string
  updatedAt?: string | null
  updatedBy?: string | null
}

// ── Sync environments (admin) ────────────────────────────────────

export type EnvAccessMode = "read_only" | "read_write"
export type EnvOperation =
  | "query_read" | "schema_introspect" | "sync_preview"
  | "sync_execute" | "ddl" | "dml"

export interface SyncEnvironmentAdmin {
  name: string
  displayName: string
  color: string
  role: "source" | "target" | "both"
  ringOrder: number
  agentServiceBaseUrl: string | null
  etlServiceBaseUrl: string | null
  gateServiceBaseUrl: string | null
  defaultAccessMode: EnvAccessMode
  allowedOperations: EnvOperation[]
  denyDml: boolean
  denyDdl: boolean
  approvalRequiredOperations: EnvOperation[]
  syncAllowlist: string[]
  allowedSyncTargets: string[] | null
  updatedAt: string
  updatedBy: string | null
}

export type SyncDefinitionAdminReviewStatus = "legacy-review-required" | "reviewed"

export interface SyncDefinitionAdminItem {
  id: string
  displayName: string
  entityVersion: number
  tableCount: number
  flowPreset: EntityRegistrySyncFlowPreset
  executionSteps: AuthoredSyncFlowStep[]
  serviceProfileRef: string
  environmentPolicyRef: string
  ownershipTeam: string
  ownershipOwner: string | null
  reviewStatus: SyncDefinitionAdminReviewStatus
  ownershipNotes: string[]
  updatedAt: string
  updatedBy: string | null
  publishedVersion: string | null
  publishedAt: string | null
}

// ── Notifications ────────────────────────────────────────────────

export interface NotificationAction {
  label: string
  action: string
  data?: Record<string, unknown>
}

export interface Notification {
  id: string
  type: string       // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  runId: string | null
  stepId: string | null
  actions: NotificationAction[]
  read: boolean
  createdAt: string
}

// ── Rollback ─────────────────────────────────────────────────────

export interface RollbackResult {
  total: number
  compensated: number
  skipped: number
  failed: Array<{ effectId: string; target: string; reason: string }>
}

export interface RollbackPreview {
  wouldCompensate: Array<{ effectId: string; target: string; kind: string; hasSnapshot: boolean }>
  wouldSkip: Array<{ effectId: string; target: string; reason: string }>
  wouldFail: Array<{ effectId: string; target: string; reason: string }>
}
