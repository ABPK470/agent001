/**
 * Sync plan persistence.
 *
 * `sync_preview` produces a SyncPlan with a UUID. The plan is cached
 * (memory + disk) so `sync_execute` references the planId rather than raw
 * inputs — guaranteeing what the user previewed is what runs.
 *
 * - 24h TTL on disk
 * - 1h TTL for execution (safety rail in sync_execute)
 * - JSON-serializable
 */

import type { CompiledSyncPlanContract, SyncPlanMovement, SyncPlanTableStats } from "@mia/shared-types"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { resolve } from "node:path"
import type { SyncEntityId } from "../../domain/definition-selection.js"
import { SyncPlanChangeType, type SyncPlanStoreHost } from "../../ports/index.js"
import { validatePlan } from "./orchestrator/plan-table.js"

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
    prodSyncUnlocked: boolean
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
 * A row whose PK exists on target but is associated with a different parent
 * scope than the source expects. e.g. source has `activityId=999` under
 * `pipelineId=123`, but on target `activityId=999` lives under `pipelineId=456`.
 */
export interface SyncPlanConflict {
  /** Composite-aware PK identifier used to match between source/target. */
  pk: string
  /** Source-side scope value(s) — "what the user thinks this row belongs to". */
  expectedScope: Record<string, unknown>
  /** Target-side scope value(s) — "where it actually lives now on target". */
  actualScope: Record<string, unknown>
  /** Human-readable summary, e.g. "activityId=999 belongs to pipelineId=456 on target, expected pipelineId=123". */
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
   * Scope-misattribution conflicts — populated when a row classified as
   * INSERT (PK absent in target scope) actually exists on target under a
   * different parent. Always blocks execute when non-empty.
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
  planId: string
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

// ── Store ────────────────────────────────────────────────────────

// In-memory plan cache lives on the supplied host (`host.sync.plans.memCache`).

const TTL_MS = 24 * 60 * 60 * 1000
const EXECUTE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Configure the disk root for plan persistence (under `MIA_DATA_DIR/sync-plans`, default `~/.mia/sync-plans`). Idempotent.
 */
export function configurePlanStore(host: SyncPlanStoreHost, diskRoot: string): void {
  host.sync.plans.diskRoot = diskRoot
  if (!existsSync(diskRoot)) mkdirSync(diskRoot, { recursive: true })
  pruneExpired(host)
}

/** Allocate a new plan UUID. */
export function allocPlanId(): string {
  return randomUUID()
}

/** Persist a plan (memory + disk + durable sink, if installed). */
export function savePlan(host: SyncPlanStoreHost, plan: SyncPlan): void {
  validatePlan(plan)
  const plans = host.sync.plans
  plans.memCache.set(plan.planId, plan)
  if (plans.diskRoot) {
    const path = resolve(plans.diskRoot, `${plan.planId}.json`)
    writeFileSync(path, JSON.stringify(plan, null, 2))
  }
  // Durable persistence (e.g. server's SQLite-backed sink). Survives restarts
  // and the disk-JSON 24h TTL — required so the History modal can re-hydrate
  // older plans on demand.
  try {
    host.sync.runs.sink.savePlan?.(plan, host.sync.runs.actorUpn)
  } catch {
    /* sink failure must not break preview */
  }
}

/** Load a plan. Returns null if missing. Tries memory → disk → durable sink. */
export function loadPlan(host: SyncPlanStoreHost, planId: string): SyncPlan | null {
  const plans = host.sync.plans
  const cached = plans.memCache.get(planId)
  if (cached && !isExpired(cached)) return cached
  // Disk fast path (in-process, may be expired by 24h TTL).
  if (plans.diskRoot) {
    const path = resolve(plans.diskRoot, `${planId}.json`)
    if (existsSync(path)) {
      try {
        const plan = JSON.parse(readFileSync(path, "utf-8")) as SyncPlan
        if (!isExpired(plan)) {
          plans.memCache.set(planId, plan)
          return plan
        }
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
      } catch {
        /* fall through to durable sink */
      }
    }
  }
  // Durable sink (e.g. SQLite). No TTL — required for History re-hydration
  // after server restart.
  try {
    const fromSink = host.sync.runs.sink.loadPlan?.(planId) ?? null
    if (fromSink) {
      plans.memCache.set(planId, fromSink)
      return fromSink
    }
  } catch {
    /* sink failure → treat as miss */
  }
  return null
}

/** True when the plan is too old to execute (1h cap). */
export function planTooOldToExecute(plan: SyncPlan): boolean {
  return Date.now() - plan.createdAtMs > EXECUTE_MAX_AGE_MS
}

/** Drop a plan from memory + disk (after successful execute). */
export function deletePlan(host: SyncPlanStoreHost, planId: string): void {
  const plans = host.sync.plans
  plans.memCache.delete(planId)
  if (plans.diskRoot) {
    const path = resolve(plans.diskRoot, `${planId}.json`)
    if (existsSync(path))
      try {
        unlinkSync(path)
      } catch {
        /* ignore */
      }
  }
}

function isExpired(plan: SyncPlan): boolean {
  return Date.now() - plan.createdAtMs > TTL_MS
}

function pruneExpired(host: SyncPlanStoreHost): void {
  const diskRoot = host.sync.plans.diskRoot
  if (!diskRoot) return
  for (const f of readdirSync(diskRoot)) {
    if (!f.endsWith(".json")) continue
    const path = resolve(diskRoot, f)
    try {
      const stats = statSync(path)
      if (Date.now() - stats.mtimeMs > TTL_MS) unlinkSync(path)
    } catch {
      // ignore
    }
  }
}
