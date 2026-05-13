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

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { currentRuntime } from "../agent-runtime.js"
import type { EntityType } from "./recipes.js"

export interface SyncPlanTableCounts {
  insert: number
  update: number
  delete: number
  unchanged: number
  /** Reserved for future use; HASHBYTES-based diff cannot produce NULL hashes. */
  lowConfidence: number
  /**
   * Rows whose PK exists on target but under a DIFFERENT parent/scope than
   * what source expects (scope misattribution). These would silently fail
   * with PK violations on execute, so we surface them in preview and
   * hard-refuse execute when > 0.
   */
  conflicts: number
}

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
  scopePredicate: string
  counts: SyncPlanTableCounts
  /** Up to 3 sample rows per bucket. */
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
  status: "unchanged" | "updates" | "deletes" | "inserts"
  counts: SyncPlanTableCounts
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

export interface SyncPlan {
  planId: string
  createdAt: string
  /** ms since epoch for fast TTL math. */
  createdAtMs: number
  entity: { type: EntityType; id: string | number; displayName: string | null }
  source: string
  target: string
  /** Pre-flight catalog drift report. */
  preflight: { catalogCompatible: boolean; issues: string[] }
  tables: SyncPlanTable[]
  totals: SyncPlanTotals
  dependencyGraph: SyncPlanGraph
  warnings: string[]
  estimatedDurationSec: number
  /** Recipe snapshot used — included so execute reproduces preview exactly. */
  recipeSnapshot: { entityType: EntityType; rootTable?: string; rootKeyColumn?: string; legacyPipelineId?: number; tables: Array<{ name: string; scopeColumn: string | null; predicate: string }>; executionOrder: string[]; reverseOrder: string[]; enabledOptionalTables?: string[] }
}

// ── Store ────────────────────────────────────────────────────────

// In-memory plan cache lives on the active AgentRuntime
// (`currentRuntime().sync.plans.memCache`).
// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.

const TTL_MS = 24 * 60 * 60 * 1000
const EXECUTE_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Configure the disk root for plan persistence (e.g.
 * `packages/server/data/sync-plans`). Idempotent.
 */
export function configurePlanStore(diskRoot: string): void {
  currentRuntime().sync.plans.diskRoot = diskRoot
  if (!existsSync(diskRoot)) mkdirSync(diskRoot, { recursive: true })
  pruneExpired()
}

/** Allocate a new plan UUID. */
export function allocPlanId(): string {
  return randomUUID()
}

/** Persist a plan (memory + disk + durable sink, if installed). */
export function savePlan(plan: SyncPlan): void {
  const runtime = currentRuntime()
  const plans = runtime.sync.plans
  plans.memCache.set(plan.planId, plan)
  if (plans.diskRoot) {
    const path = resolve(plans.diskRoot, `${plan.planId}.json`)
    writeFileSync(path, JSON.stringify(plan, null, 2))
  }
  // Durable persistence (e.g. server's SQLite-backed sink). Survives restarts
  // and the disk-JSON 24h TTL — required so the History modal can re-hydrate
  // older plans on demand.
  try { runtime.sync.runSink.savePlan?.(plan) } catch { /* sink failure must not break preview */ }
}

/** Load a plan. Returns null if missing. Tries memory → disk → durable sink. */
export function loadPlan(planId: string): SyncPlan | null {
  const runtime = currentRuntime()
  const plans = runtime.sync.plans
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
        try { unlinkSync(path) } catch { /* ignore */ }
      } catch { /* fall through to durable sink */ }
    }
  }
  // Durable sink (e.g. SQLite). No TTL — required for History re-hydration
  // after server restart.
  try {
    const fromSink = runtime.sync.runSink.loadPlan?.(planId) ?? null
    if (fromSink) {
      plans.memCache.set(planId, fromSink)
      return fromSink
    }
  } catch { /* sink failure → treat as miss */ }
  return null
}

/** True when the plan is too old to execute (1h cap). */
export function planTooOldToExecute(plan: SyncPlan): boolean {
  return Date.now() - plan.createdAtMs > EXECUTE_MAX_AGE_MS
}

/** Drop a plan from memory + disk (after successful execute). */
export function deletePlan(planId: string): void {
  const plans = currentRuntime().sync.plans
  plans.memCache.delete(planId)
  if (plans.diskRoot) {
    const path = resolve(plans.diskRoot, `${planId}.json`)
    if (existsSync(path)) try { unlinkSync(path) } catch { /* ignore */ }
  }
}

function isExpired(plan: SyncPlan): boolean {
  return Date.now() - plan.createdAtMs > TTL_MS
}

function pruneExpired(): void {
  const diskRoot = currentRuntime().sync.plans.diskRoot
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
