/**
 * Shared frontend types — mirrors the server API contract.
 *
 * Wire enums are imported from `@mia/shared-enums` (single source of
 * truth across agent/server/UI). Never declare a parallel `"a" | "b"`
 * union for a value set that already exists in shared-enums — import
 * the type instead so renames flow automatically.
 */

import type { SyncHandlerInput } from "./handler-input.js"
import type {
    DelegationEndStatus,
    DirectLoopFallbackSource,
    EffectClass,
    EscalationAction,
    EscalationReason,
    EventType,
    PlannerRoute,
    PlannerStepPhase,
    PolicySource,
    VerificationMode,
    VerifierMode,
    VerifierOutcome,
} from "@mia/shared-enums"
import type { SyncPlanMovement, SyncPlanTableStats } from "./sync-plan.js"
import type { PlatformImportGateResult } from "./import-gate.js"

export type {
    DelegationEndStatus,
    DirectLoopFallbackSource,
    EffectClass,
    EscalationAction,
    EscalationReason,
    EventType,
    PlannerRoute,
    PlannerStepPhase,
    VerificationMode,
    VerifierMode,
    VerifierOutcome
}

export {
  CONNECTOR_KINDS,
  ENABLED_CONNECTOR_KINDS,
  SECRET_MASK,
  type AdapterCapabilities,
  type AdapterFactory,
  type CastKind,
  type Connector,
  type ConnectorAdmin,
  type ConnectorConfigField,
  type ConnectorConfigFieldType,
  type ConnectorConfigValidation,
  type ConnectorInfo,
  type ConnectorKind,
  type ConnectorKindId,
  type AqueductReadSpec,
  type AwsReadSpec,
  type AwsWriteSpec,
  type AzureReadSpec,
  type AzureWriteSpec,
  type ConnectorAdapter,
  type DenodoReadSpec,
  type FileFormat,
  type FtpReadSpec,
  type FtpWriteSpec,
  type HttpApiReadSpec,
  type HttpApiWriteSpec,
  type MovementError,
  type MovementStatus,
  type MovementValue,
  type MoveSummary,
  type ReadSpec,
  type Row,
  type SqlReadSpec,
  type SqlWriteSpec,
  type Transform,
  type TransformColumn,
  type TransformDefault,
  type TransformDerive,
  type TransformFilter,
  type TransformFilterOp,
  type WebhdfsReadSpec,
  type WebhdfsWriteSpec,
  type WriteMode,
  type WriteOptions,
  type WriteSpec,
  getConnectorKind,
  isConnectorKindId,
  maskConnectorConfig,
  toConnectorId,
  validateConnectorConfig,
  withConnectorConfigDefaults,
} from "./connectors.js"


// ── Run ──────────────────────────────────────────────────────────

export interface Thread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  pinned?: boolean
  runCount?: number
}

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  parentRunId: string | null
  agentId: string | null
  threadId?: string | null
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
  | { kind: "planner-decision"; score: number; shouldPlan: boolean; route?: PlannerRoute; reason: string }
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
  | {
    /**
     * Coalesced live sync progress for chat trace (preview / bulk scan / execute).
     * One entry per sync tool invocation — updated in place as SSE events arrive.
     */
    kind: "sync-progress"
    invocationId: string
    tool: string
    status: "running" | "done" | "error"
    headline: string
    detail?: string
    level?: "info" | "warn" | "error"
    sql?: {
      label: string
      connection: string
      preview: string
      rowCount?: number | null
      durationMs?: number | null
    }
    lastTable?: {
      name: string
      index?: number
      total?: number
      insert?: number
      update?: number
      delete?: number
      status?: "running" | "done" | "error"
    }
    result?: string
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
  | "thread-nav"
  | "agent-chat"
  | "term-chat"
  | "run-status"
  | "live-logs"
  | "step-timeline"
  | "run-history"
  | "debug-inspector"
  | "mymi-db"
  | "active-users"
  | "env-sync"
  | "operation-log"
  | "entity-registry"
  | "sync-proposals"
  | "sync-approvals"
  | "sync-evidence"
  | "sync-admin"
  | "bridge"

/**
 * Widget types visible AND interactive for non-admin "visitor" users.
 * Other widgets still appear in the catalogue (so visitors see what
 * exists) but are rendered as disabled cards. Admins get the full set.
 */
export const VISITOR_WIDGETS: ReadonlySet<WidgetType> = new Set([
  "thread-nav",
  "term-chat",
  "env-sync",
  "live-logs",
  "operation-log",
  "mymi-db",
  "run-history",
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
  /** When true, tile cannot be dragged or resized until unpinned. */
  pinned?: boolean
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

export {
  readSseEntityId,
  readSseRunId,
  readSseStepId,
  readSseToolCallId,
  readSseToolName,
  readToolEntityId,
  sseStepDedupeToken
} from "./sse-payload.js"

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
  allowedSyncEnvironments: string[] | null
}

export interface SyncRecipeTable {
  name: string
  scopeColumn: string | null
  predicate: string
  source: "fk+pipeline" | "fk-only" | "pipeline-only" | "manual"
  verified: boolean
  groundedByPipeline?: boolean
  enabledByDefault?: boolean
  userControllable?: boolean
  note?: string
}

/** @deprecated Use PublishedSyncDefinition at runtime. */
export type SyncRecipeTableLegacy = SyncRecipeTable

export type { SyncPlanMovement, SyncPlanTableStats } from "./sync-plan.js"
export {
  computePlanTotals,
  movementFromChangeSet,
  movementOfTable,
  tableHasMovement,
  tableMovementTotal
} from "./sync-plan.js"

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

export interface SyncPlanChangeRow {
  pk: string
  values: Record<string, unknown>
}

/** Row-level work manifest from preview — execute applies exactly this set. */
export interface SyncPlanChangeSet {
  insert: SyncPlanChangeRow[]
  update: SyncPlanChangeRow[]
  delete: SyncPlanChangeRow[]
}

export interface SyncPlanTable {
  table: string
  /**
   * Frozen SQL WHERE fragment from preview.
   * Execute uses this only for drift `COUNT(*)` and FK probes — never for bulk row reads.
   */
  scopePredicate: string
  /** Preview-only counters not represented in `changeSet`. */
  stats: SyncPlanTableStats
  /** Execute authority — insert / update / delete PK lists. */
  changeSet: SyncPlanChangeSet
  /** UI preview decoration only; execute ignores. */
  samples: {
    insert: SyncPlanRowSample[]
    update: SyncPlanRowSample[]
    delete: SyncPlanRowSample[]
  }
  /** Scope-misattribution rows; length is the conflict count. Blocks execute when non-empty. */
  conflicts: SyncPlanConflict[]
  warnings: string[]
  diffDurationMs: number
}

export interface SyncPlanGraphNode {
  id: string
  label: string
  status: "unchanged" | "updates" | "deletes" | "inserts"
  stats: SyncPlanTableStats
  movement: SyncPlanMovement
}

export interface SyncPlanGraph {
  nodes: SyncPlanGraphNode[]
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

export interface SyncPlanPreflight {
  catalogCompatible: boolean
  issues: string[]
  rootParentReady: boolean
  rootParentIssue: string | null
}

export interface SyncPlan {
  planId: string
  createdAt: string
  createdAtMs: number
  entity: { type: SyncEntityType; id: string | number; displayName: string | null }
  source: string
  target: string
  preflight: SyncPlanPreflight
  tables: SyncPlanTable[]
  totals: SyncPlanTotals
  dependencyGraph: SyncPlanGraph
  warnings: string[]
  estimatedDurationSec: number
  executionContract: CompiledSyncPlanContract
  decisionLog?: CompiledSyncDecisionRecord[] | null
  governanceDecision?: CompiledSyncGovernanceDecision | null
}

export type AuthoredSyncFlowPhase =
  | "preTransaction"
  | "metadata"
  | "postMetadata"
  | "postCommit"

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
  // User-authored custom flow kinds (custom_sql / custom_shell_script handlers).
  | (string & {})

export interface AuthoredSyncDefinitionGovernance {
  freezeWindowIds: string[]
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
  /** @deprecated Ignored at runtime — execution regions are derived from order around metadataSync. */
  phase?: AuthoredSyncFlowPhase
  kind: AuthoredSyncFlowKind
  title: string
  description: string
  /** Per-step value source wiring for handler slots without kind-fixed `source`. */
  bindings?: Record<string, import("./value-source.js").ValueSource>
  objectName?: string | null
  auditObjectType?: string | null
  pipelineName?: string | null
}

export type Scd2IdentityHandling = "none" | "setIdentityInsertOn" | "omit-identity-column"

/** Frozen per-table column policy — resolved at publish from strategy + overrides. */
export interface Scd2TablePolicy {
  excludeFromDiff: string[]
  onInsert: Record<string, string>
  onUpdate: Record<string, string>
  identityHandling: Scd2IdentityHandling
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
  /** Required on published definitions — drives diff + MERGE stamping at runtime. */
  scd2Policy?: Scd2TablePolicy
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
    /** Phase + step-type defs for `steps` — frozen at publish; sole source at preview/execute. */
    catalog?: SyncFlowCatalogSnapshot
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

export interface PublishedSyncDefinitionBundle {
  version: 1
  publishedAt: string
  publishedVersion: string
  /** Active sync catalog version stamped at publish time (absent on older bundles). */
  catalogVersion?: number | null
  definitions: Record<string, PublishedSyncDefinition | null>
}

export interface SyncPublishStatus {
  catalogNeedsPublish: boolean
  activeCatalogVersion: number | null
  publishedCatalogVersion: number | null
  publishedAt: string | null
  unpublishedEntityCount: number
  unpublishedEntityIds: string[]
}

export interface PublishSyncDefinitionsResponse {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  /** Live SyncDefinitions are stored in SQLite; path is a stable label, not a file. */
  publishedStorage: "sqlite"
  /** @deprecated Use publishedStorage — kept for older UI clients. */
  publishedBundlePath?: string
  stdout: string[]
  stderr: string[]
}

export type SyncDefinitionFlowTemplateId =
  | "contract"
  | "dataset"
  | "rule"
  | "pipelineActivity"
  | "gateMetadata"
  | "content"
  | "metadataOnly"

export interface EntityRegistrySyncDefinitionScaffoldRequest {
  flowTemplateId?: SyncDefinitionFlowTemplateId
  serviceProfileRef?: string
  environmentPolicyRef?: string
}

export interface EntityRegistrySyncDefinitionScaffoldResponse {
  suggestedPath: string
  definition: AuthoredSyncDefinition
  stderr: string[]
}

export interface EntityRegistryDraftIdentitySuggestion {
  id: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn: string | null
}

export interface EntityRegistryDraftSuggestion {
  identity: EntityRegistryDraftIdentitySuggestion
  tables: EntityRegistryTable[]
  flowTemplateId: EntityRegistrySyncFlowTemplateId | null
  source: "heuristic" | "catalog"
  notes: string[]
}

export interface EntityRegistryTableSuggestion {
  table: EntityRegistryTable
  source: "heuristic" | "catalog" | "unreachable"
  note: string | null
}

export interface CompiledSyncPlanStep {
  id: string
  /** @deprecated Ignored at runtime — execution regions are derived from order around metadataSync. */
  phase?: AuthoredSyncFlowPhase
  kind: AuthoredSyncFlowKind
  title: string
  description: string
  bindings?: Record<string, import("./value-source.js").ValueSource>
  objectName?: string | null
  auditObjectType?: string | null
  pipelineName?: string | null
}

export interface CompiledSyncPlanContract {
  definitionId: string
  definitionPublishedVersion: string
  definitionPublishedAt: string
  governance: AuthoredSyncDefinitionGovernance
  bindings: AuthoredSyncDefinitionBindingRefs
  allowedSchemas: string[]
  metadata: {
    rootTable: string
    rootKeyColumn: string
    selfJoinColumn: string | null
    tables: Array<{ name: string; scopeColumn: string | null; predicate: string; scd2Policy?: Scd2TablePolicy }>
    executionOrder: string[]
    reverseOrder: string[]
    enabledOptionalTables?: string[]
  }
  flow: {
    steps: CompiledSyncPlanStep[]
    /** Kind + phase definitions snapshotted at preview for self-contained execution. */
    catalog?: SyncFlowCatalogSnapshot
  }
  provenance: {
    kind: "manual" | "legacy-migration"
    sourceArtifact?: string | null
    sourceVersion?: string | null
  }
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
    actorUpn: string | null
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
  type:
    | "started"
    | "step"
    | "deploy-step"
    | "table-started"
    | "table-progress"
    | "table-done"
    | "completed"
    | "skipped"
    | "failed"
  table?: string
  step?: string
  rowsApplied?: number
  rowsTotal?: number
  message?: string
  error?: string
  /** Present on `deploy-step` events. `started` is in-flight telemetry; terminal states are audit-log rows. */
  deployStatus?: "started" | "done" | "failed" | "skipped"
}

// ── Entity registry (Phase 0 config uplift) ──────────────────────
//
// Wire shape for the entity registry's REST + SSE surface. The full
// in-memory shape (with discriminated `scope.kind`, override semantics,
// validation codes, etc.) lives in `@mia/agent` — these DTOs are just
// JSON-stable mirrors used by the UI store and route bodies.

export type EntityRegistryProvenanceKind = "bundled" | "imported" | "manual" | "agent"

export interface EntityRegistryFkHop {
  /** Schema-qualified table name traversed. */
  table: string
  /** Column on the previous hop (or root) whose value is matched. */
  fromColumn: string
  /** Column on `table` that holds the matching value. */
  toColumn: string
}

export type EntityRegistryTableScope =
  | { kind: "rootPk"; column: string }
  | { kind: "sql"; predicate: string }
  /** @deprecated Legacy import only — normalized to `sql` on read/save. Kept so domain
   *  `EntityTable` values (which may carry this shape in-memory during import) are
   *  assignable to the API contract. Persisted registry tables never use `fkPath`. */
  | { kind: "fkPath"; through: EntityRegistryFkHop[] }

export type EntityRegistryProvenance =
  | { kind: "manual" }
  | { kind: "bundled" }
  | { kind: "agent"; runId?: string | null }
  | { kind: "imported"; sourceManifestId?: string; source?: string }
  | { kind: "template"; templateId: string; templateVersion?: number; entityId?: string }
  | { kind: "legacy-migration"; legacyPipelineId: number | null }
  /** Discovered from a stored procedure body (legacy pipeline evidence). */
  | { kind: "sproc"; sprocName: string; lineRange?: [number, number] }
  /** Discovered by a configured importer. */
  | { kind: "importer"; importerId: string }
  /** Suggested from the FK graph; confidence reflects verification state. */
  | { kind: "fkGraphSuggester"; confidence: "high" | "medium" | "low" }

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

export { renumberEntityRegistryTables } from "./entity-registry-table-order.js"

export interface EntityRegistryPolicies {
  freezeWindowIds: string[]
}

export interface EntityRegistryLineageRef {
  object: string
  kind: "view-source" | "report-source" | "downstream-consumer"
  note: string | null
}

export interface EntityRegistryScd2Override {
  excludeFromDiff?: string[]
  identityHandling?: Scd2IdentityHandling
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
  /** Flow in sync-metadata that defines execution steps for this entity. */
  flowId: string
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
  excludeFromDiff: string[]
  identityHandling: Scd2IdentityHandling
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

export interface EntityRegistryStrategyHistoryEntry {
  tenantId: string
  id: string
  version: number
  versionLabel: string | null
  createdBy: string
  createdAt: string
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

export interface EntityRegistryYamlImportPreview {
  def: EntityRegistryDefinition
}

export interface EntityRegistryYamlImportResponse extends PlatformImportGateResult {
  saved: Array<{ id: string; version: number; created: boolean }>
  skipped: Array<{ id: string; reason: string }>
  /**
   * Structured per-row errors for the YAML editor.
   * Gate `errors` is the parallel string list for ImportGateModal.
   */
  rowErrors: Array<{ id: string | null; error: EntityRegistryValidationResult | string }>
  /** Populated on dry-run when parse succeeds — use to hydrate structured editor fields. */
  preview?: EntityRegistryYamlImportPreview[]
}

export interface EntityRegistryPreviewYamlRequest {
  def: EntityRegistryDefinition
}

export interface EntityRegistryPreviewYamlResponse {
  yaml: string
}

export interface EntityRegistryPreviewJsonRequest {
  def: EntityRegistryDefinition
}

export interface EntityRegistryPreviewJsonResponse {
  json: string
}

export type EntityRegistrySyncFlowTemplateId =
  | "contract"
  | "dataset"
  | "rule"
  | "pipelineActivity"
  | "gateMetadata"
  | "content"
  | "metadataOnly"

export interface SyncDefinitionRuntimeOption<T extends string = string> {
  id: T
  label: string
  description?: string | null
}

export interface SyncDefinitionRuntimeOptions {
  flowTemplates: SyncDefinitionRuntimeOption<EntityRegistrySyncFlowTemplateId>[]
  flowTemplateSteps: Record<EntityRegistrySyncFlowTemplateId, AuthoredSyncFlowStep[]>
  serviceProfiles: SyncDefinitionRuntimeOption[]
  environmentPolicies: SyncDefinitionRuntimeOption[]
}

/** When in the sync run a phase's steps execute (execution contract). */
export type SyncFlowPhaseBoundary =
  | "pre_metadata"
  | "metadata_transaction"
  | "post_metadata"
  | "post_commit"

export interface SyncFlowPhaseDefinition {
  /** One-line summary for lists. */
  summary: string
  /** Operator-facing explanation of what this phase means. */
  description: string
  /** Runtime execution boundary (see SYNC-PREVIEW-EXECUTE.md). */
  boundary: SyncFlowPhaseBoundary
  /** Primary database connection for steps in this phase. */
  connection: "source" | "target" | "mixed"
  defaultFailureMode: "fatal" | "warning"
  /** How step order relates to this phase today. */
  orderingHint: string
}

export type SyncFlowKindHandlerType =
  | "metadata_sync"
  | "mssql_procedure"
  | "http_request"
  | "custom_sql"
  | "custom_shell_script"

export {
  CATALOG_ID_PATTERN,
  idToCatalogDescription,
  idToCatalogLabel,
  isCatalogId,
  METADATA_SYNC_KIND_ID,
  validateCatalogId,
} from "./catalog-id.js"
export {
  CATALOG_RESOLVER_KIND_OPTIONS,
  catalogResolverFamilyLabel,
  customValueSourceCatalogFromRows,
  defaultCatalogResolver,
  effectiveTargetSqlResultType,
  formatCatalogResolverRuntimePreview,
  formatCustomValueSourcePreview,
  inferTargetSqlResultType,
  lookupCustomValueSource,
  normalizeCustomValueSourceDefinition,
  parseCustomValueSourceDefinition,
  validateCustomValueSourceId,
  validateTargetSqlQuery,
  type CatalogResolver,
  type CustomValueSourceCatalog,
  type CustomValueSourceDefinition,
} from "./custom-value-source.js"
export {
  lookupHttpServiceSlot,
  SYNC_CUSTOM_HANDLER_TOKENS,
  SYNC_HTTP_SERVICE_SLOTS,
  type SyncHttpServiceSlot,
  type SyncHttpServiceSlotDefinition,
} from "./handler-vocabulary.js"
export {
  formatHandlerInputPreviewHint,
  formatPlanBindingSourceDisplayLabel,
  formatStepFieldDisplayLabel,
  planBindingKindDisplayPrefix,
  type BindingSourceLabelCatalog,
  type CustomValueSourceLabelCatalog,
} from "./binding-display.js"
export {
  collectCatalogIdsFromValueSource,
  collectCatalogIdsFromValueSources,
  formatValueSourcePreview,
  isLiteralValueSource,
  isSyncStepFieldKey,
  isValueSource,
  normalizeValueSourceToCatalog,
  readStepFieldValue,
  stepFieldKeysFromValueSource,
  SYNC_STEP_FIELD_KEYS,
  validateValueSource,
  valueSourceCatalogId,
  type SyncStepFieldKey,
  type ValueSource,
} from "./value-source.js"
export {
  catalogStepFieldIds,
  collectKnownFlowStepIds,
  flowStepPickerOptions,
  publishedOutputKeysForKind,
  publishedOutputKeysForStep,
  suggestPriorStepOutputKeys,
  type FlowStepPickerOption,
} from "./flow-catalog-ui.js"
export {
  assertPublishedOutputsPresent,
  derivePublishedOutputsFromHandler,
  formatStepOutputPreviewJson,
  guaranteedHandlerInputOutputKeys,
  normalizePublishedOutputKeys,
  procedureParameterOutputKeys,
  stepOutputPreview,
  type StepOutputPreview,
} from "./step-published-outputs.js"
export {
  collectCatalogIdsFromFlowSteps,
  collectBindingSourceIdsFromFlowSteps,
  isKindFixedBindingSlot,
  isLiteralHandlerSlot,
  isStepBoundHandlerSlot,
  requiredStepBoundSlotNames,
  resolveSlotValueSource,
  stepFieldIdsForStep,
  stepFieldIdsFromHandler,
  stepFieldKeysForStep,
  stepFieldKeysFromHandler,
} from "./flow-step-bindings.js"
export {
  collectBindingSourceIdsFromKindDefinitions,
  collectBindingSourceIdsFromSteps,
  collectCustomValueSourceIdsFromKindDefinitions,
  collectCustomValueSourceIdsFromSteps,
  DEFAULT_CUSTOM_HANDLER_INPUTS,
  DEFAULT_PROCEDURE_INPUTS,
  formatHandlerInputLiteral,
  handlerInputSlots,
  substituteInputTokens,
  type SyncHandlerInput,
} from "./handler-input.js"
export type { SyncProcedureParameter } from "./handler-input.js"

export interface SyncFlowKindHandler {
  type: SyncFlowKindHandlerType
  connection: "source" | "target"
  procedure?: string
  /** Stored procedure parameters — same slots as {@link SyncHandlerInput}. */
  parameters?: SyncHandlerInput[]
  httpService?: "etl" | "agent" | "gate"
  httpMethod?: "GET" | "POST"
  httpPath?: string
  /** JSON body fields for HTTP handlers. */
  httpBody?: SyncHandlerInput[]
  sqlBatch?: string
  shellCommand?: string
  shellPlatform?: "linux" | "windows" | "any"
  /** Input slots for @token substitution in SQL batches and shell commands. */
  inputs?: SyncHandlerInput[]
}

export interface SyncFlowKindDefinition {
  summary: string
  description: string
  handler: SyncFlowKindHandler
  /** @deprecated Always {} — step fields are driven by flow step bindings. */
  stepFields: Record<string, boolean>
  failureMode: "fatal" | "warning"
  /** Marks dataset-layer create steps (contract deploy sequencing). */
  createsDatasetLayer?: boolean
  /**
   * Keys this action publishes for earlier-step bindings.
   * Must match runtime StepOutputRegistry entries after the step succeeds.
   */
  publishedOutputs?: readonly string[]
  /** Skip when contract dataset layer failed (from kind definition in run catalog). */
  skipWhenDatasetLayerFailed?: boolean
  entityTypes?: Array<
    "contract" | "dataset" | "rule" | "pipelineActivity" | "gateMetadata" | "content" | "any"
  >
}

/** Phase + kind definitions referenced by a compiled execution contract. */
export interface SyncFlowCatalogSnapshot {
  phases: Record<string, SyncFlowPhaseDefinition>
  kinds: Record<string, SyncFlowKindDefinition>
  customValueSources: Record<string, import("./custom-value-source.js").CustomValueSourceDefinition>
}

export interface SyncMetadataCatalogPhase {
  id: string
  label: string
  sortOrder: number
  builtIn: boolean
  definition: SyncFlowPhaseDefinition
}

export interface SyncMetadataCatalogAction {
  id: string
  label: string
  builtIn: boolean
  definition: SyncFlowKindDefinition
}

/** @deprecated Use SyncMetadataCatalogAction */
export type SyncMetadataCatalogStepType = SyncMetadataCatalogAction

export interface SyncMetadataCatalogFlow {
  id: string
  label: string
  description: string
  steps: AuthoredSyncFlowStep[]
  builtIn: boolean
}

export interface SyncMetadataCatalogValueSource {
  id: string
  label: string
  builtIn: boolean
  definition: import("./custom-value-source.js").CustomValueSourceDefinition
}

/** @deprecated Use SyncMetadataCatalogValueSource */
export type SyncMetadataCatalogCustomValueSource = SyncMetadataCatalogValueSource

/** DB-backed sync vocabulary for the Entity Registry UI (actions, flows, value sources). */
export interface SyncMetadataCatalogResponse {
  actions: SyncMetadataCatalogAction[]
  flows: SyncMetadataCatalogFlow[]
  valueSources: SyncMetadataCatalogValueSource[]
}

export interface SyncMetadataCatalogValueSourceSaveBody {
  id: string
  label: string
  definition?: import("./custom-value-source.js").CustomValueSourceDefinition
}

/** @deprecated Use SyncMetadataCatalogValueSourceSaveBody */
export type SyncMetadataCatalogCustomValueSourceSaveBody = SyncMetadataCatalogValueSourceSaveBody

export interface SyncMetadataCatalogPhaseSaveBody {
  id: string
  label: string
  sortOrder?: number
  definition?: SyncFlowPhaseDefinition
}

export interface SyncMetadataCatalogActionSaveBody {
  id: string
  label: string
  definition?: SyncFlowKindDefinition
}

/** @deprecated Use SyncMetadataCatalogActionSaveBody */
export type SyncMetadataCatalogStepTypeSaveBody = SyncMetadataCatalogActionSaveBody

/** @deprecated Use SyncMetadataCatalogPhase */
export type SyncRunCatalogPhase = SyncMetadataCatalogPhase
/** @deprecated Use SyncMetadataCatalogAction */
export type SyncRunCatalogKind = SyncMetadataCatalogAction
/** @deprecated Use SyncMetadataCatalogFlow */
export type SyncRunCatalogPreset = SyncMetadataCatalogFlow
/** @deprecated Use SyncMetadataCatalogResponse */
export type SyncRunCatalogResponse = SyncMetadataCatalogResponse
/** @deprecated Use SyncMetadataCatalogPhaseSaveBody */
export type SyncRunCatalogPhaseSaveBody = SyncMetadataCatalogPhaseSaveBody
/** @deprecated Use SyncMetadataCatalogActionSaveBody */
export type SyncRunCatalogKindSaveBody = SyncMetadataCatalogActionSaveBody

export interface EntityRegistrySyncDefinitionExportRequest {
  flowTemplateId?: EntityRegistrySyncFlowTemplateId
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
    supportedFlowTemplates: EntityRegistrySyncFlowTemplateId[]
  }
  compatibilityLayers: EntityRegistrySyncDefinitionStatusLayer[]
  definitions: EntityRegistrySyncDefinitionStatusItem[]
}

export interface EntityRegistrySyncDefinitionExportResponse {
  tenantId: string
  entityId: string
  outputPath: string
  flowTemplateId: EntityRegistrySyncFlowTemplateId
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
  /**
   * Optional link to a managed connector (see `Connector`). Pure metadata in
   * this phase — the sync orchestrator still resolves the environment by
   * `name` against the MSSQL connection registry, so this field does not
   * change sync behaviour. It exists so the connections form can record which
   * connector backs an environment ahead of the connector-becomes-SOT step.
   */
  connectorId?: string | null
  role: "source" | "target" | "both"
  ringOrder: number
  agentServiceBaseUrl: string | null
  etlServiceBaseUrl: string | null
  gateServiceBaseUrl: string | null
  /** Named HTTP service base URLs — supersedes legacy agent/etl/gate fields per key. */
  serviceUrls?: Record<string, string | null>
  defaultAccessMode: EnvAccessMode
  allowedOperations: EnvOperation[]
  denyDml: boolean
  denyDdl: boolean
  approvalRequiredOperations: EnvOperation[]
  allowedSyncEnvironments: string[] | null
  updatedAt: string
  updatedBy: string | null
  /** Shipped sync environments (dev/uat/prod) — require explicit unlock before edit/delete. */
  builtIn?: boolean
}

export type SyncDefinitionAdminReviewStatus = "legacy-review-required" | "reviewed"

export interface SyncDefinitionAdminItem {
  id: string
  displayName: string
  entityVersion: number
  tableCount: number
  flowTemplateId: EntityRegistrySyncFlowTemplateId
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
  /**
   * True when this entity (or the active catalog tip) is ahead of the published
   * sync bundle and a publish would recompile it.
   */
  needsPublish: boolean
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

export {
  TOOL_PRESENTATION,
  TOOL_TRACE_ARG,
  presentToolCall,
  presentToolCallFromFormatted,
  serializeToolCallArgs,
  stripRuntimeToolArgs,
  toolCallDetailPreview,
  toolCallPreview
} from "./tool-call-presentation.js"
export type {
  ToolCallArtifact,
  ToolCallPresentation,
  ToolPresentationSpec
} from "./tool-call-presentation.js"
export {
  deriveStepFields,
  deriveStepFieldsFromHandler,
  normalizeKindDefinition,
  requiredFlowStepFieldKeys,
} from "./derive-step-fields.js"
export {
  defaultAuditObjectType,
  defaultObjectName,
  defaultStepBindings,
  defaultStepFieldValue,
  derivePipelineName,
  normalizeAuthoredSyncFlowStep,
  normalizeAuthoredSyncFlowSteps,
  type FlowStepKindLookup,
  type NormalizeFlowStepContext,
} from "./normalize-flow-step.js"
export {
  formatTraceExportText,
  formatThreadExportText,
  threadExportFilename,
  traceExportFilename,
} from "./trace-export.js"
export type { TraceExportRunMeta, TraceExportThreadMeta } from "./trace-export.js"
export {
  emptyPlatformImportImpact,
  type PlatformImportGateResult,
  type PlatformImportImpact,
} from "./import-gate.js"
