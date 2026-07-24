/**
 * SyncPlan vocabulary — types only.
 * Persistence lives in `runtime/plan-store.ts`.
 */
import type { PlanId } from "./types/branded-ids.js"


import type { CompiledSyncPlanContract, SyncPlanMovement, SyncPlanTableStats } from "@mia/shared-types"
import type { SyncEntityId } from "./definition-selection.js"
import type { SyncPlanChangeType } from "./enums.js"

export type SyncExecutionContract = CompiledSyncPlanContract
export type SyncExecutionContractStep = CompiledSyncPlanContract["flow"]["steps"][number]

export interface SyncGovernanceDecision {
  evaluatedAt: string
  governance: {
    freezeWindowIds: string[]
  }
  freezeWindows: {
    active: boolean
    activeWindows: Array<{ id: string; displayName: string; startsAt: string; endsAt: string }>
    unknownIds: string[]
  }
  targetEnvironment: {
    name: string
    role: string
    actorUpn: string | null
  }
  warnings: string[]
}

export interface SyncDecisionRecord {
  id: string
  recordedAt: string
  stage: "preview" | "execute"
  category: "definition" | "flow" | "scope" | "preflight" | "governance" | "execution"
  severity: "info" | "warning" | "error"
  title: string
  summary: string
  details: Record<string, unknown>
}

export type { SyncPlanMovement, SyncPlanTableStats } from "@mia/shared-types"

export interface SyncPlanRowSample {
  /** Raw column values for an INSERT or DELETE row. */
  values?: Record<string, unknown>
  /** For an UPDATE: source-side (new) values. */
  newValues?: Record<string, unknown>
  /** For an UPDATE: target-side (old) values. */
  oldValues?: Record<string, unknown>
  /** Names of columns whose values differ (UPDATE only). */
  changedColumns?: string[]
}

/** One row in a table changeSet — PK identity only (execute fetches full rows by PK). */
export interface SyncPlanChangeRow {
  /** Composite-aware PK key (matches diff-engine `PkHashRow.pk`). */
  pk: string
  /** PK column values used to build targeted SELECT / DELETE predicates. */
  values: Record<string, unknown>
}

/**
 * Per-table insert / update / delete PK lists from preview diff.
 * Execute applies exactly this — no re-diff, no scope-wide reads.
 */
export interface SyncPlanChangeSet {
  insert: SyncPlanChangeRow[]
  update: SyncPlanChangeRow[]
  delete: SyncPlanChangeRow[]
}

/**
 * Plan-level blocker that must not become changeSet ownership.
 * Kind vocabulary + labels: `@mia/shared-types` (`sync-plan-conflicts`).
 */
import type { SyncPlanConflictKind } from "@mia/shared-types"
export type { SyncPlanConflictKind }

export interface SyncPlanConflict {
  /** Omitted on legacy plans — treat as scope_misattribution. */
  kind?: SyncPlanConflictKind
  /** Composite-aware PK identifier used to match between source/target. */
  pk: string
  /** Context for the planned action (expected parent / delete intent). */
  expectedScope: Record<string, unknown>
  /** Why the action is blocked (actual parent / referencing row). */
  actualScope: Record<string, unknown>
  /** Human-readable summary for UI / agent. */
  summary: string
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
  /** Row-level execute instructions (insert / update / delete PK lists). */
  changeSet: SyncPlanChangeSet
  /** UI preview decoration only; execute ignores. */
  samples: {
    insert: SyncPlanRowSample[]
    update: SyncPlanRowSample[]
    delete: SyncPlanRowSample[]
  }
  /**
   * Blockers that must not be claimed as changeSet work.
   * Non-empty always refuses execute (scope misattribution and inbound refs).
   */
  conflicts: SyncPlanConflict[]
  /** Warnings specific to this table (e.g. row cap exceeded, missing PK). */
  warnings: string[]
  /** Wall-clock ms spent computing this table's diff. */
  diffDurationMs: number
}

export interface SyncPlanGraphNode {
  id: string
  label: string
  /** Net change pill: green/amber/red/grey. */
  status: SyncPlanChangeType
  stats: SyncPlanTableStats
  movement: SyncPlanMovement
}

export interface SyncPlanGraph {
  nodes: SyncPlanGraphNode[]
  edges: { from: string; to: string; label?: string }[]
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
  /** False when child upserts need a root row that is neither on target nor inserted by this plan. */
  rootParentReady: boolean
  rootParentIssue: string | null
}

export interface SyncPlan {
  planId: PlanId
  createdAt: string
  /** ms since epoch for fast TTL math. */
  createdAtMs: number
  entity: { type: SyncEntityId; id: string | number; displayName: string | null }
  source: string
  target: string
  /** Pre-flight catalog drift + root-parent readiness. */
  preflight: SyncPlanPreflight
  tables: SyncPlanTable[]
  totals: SyncPlanTotals
  dependencyGraph: SyncPlanGraph
  warnings: string[]
  estimatedDurationSec: number
  /** Compiled execution contract — reproduces preview at execute time. */
  executionContract: SyncExecutionContract
  /** First-class explainability record used by history/API/UI surfaces. */
  decisionLog?: SyncDecisionRecord[] | null
  /** Preview-time governance evaluation persisted for audit and operator explainability. */
  governanceDecision?: SyncGovernanceDecision | null
  /**
   * Governance policy snapshot pulled from the entity registry at plan
   * time. Threads through into the execute preflight so freeze windows
   * + approval policies are evaluated against the entity-as-it-was-then.
   * `null` when the entity has no registry record (legacy JSON path).
   */
  entityPolicies?: {
    freezeWindowIds: string[]
    sourceEntityVersion: number | null
  } | null
}

