/**
 * Sync plan persistence (memory + disk + durable sink).
 */

import type { SyncPlanStoreHost } from "../ports/index.js"
import { validatePlan } from "./orchestrator/plan-table.js"
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
import { randomUUID } from "node:crypto"
import type { PlanId } from "../domain/types/branded-ids.js"
import { asPlanId } from "../domain/types/branded-ids.js"
import type { SyncPlan } from "../domain/plan.js"

export type {
  SyncExecutionContract,
  SyncExecutionContractStep,
  SyncGovernanceDecision,
  SyncDecisionRecord,
  SyncPlanRowSample,
  SyncPlanChangeRow,
  SyncPlanChangeSet,
  SyncPlanConflict,
  SyncPlanTable,
  SyncPlanGraphNode,
  SyncPlanGraph,
  SyncPlanTotals,
  SyncPlanPreflight,
  SyncPlan,
} from "../domain/plan.js"
export type { SyncPlanMovement, SyncPlanTableStats } from "@mia/shared-types"

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
export function allocPlanId(): PlanId {
  return asPlanId(randomUUID())
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
  } catch (err: unknown) { console.error("[mia]", err) }
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
        } catch (err: unknown) { console.error("[mia]", err) }
      } catch (err: unknown) { console.error("[mia]", err) }
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
  } catch (err: unknown) { console.error("[mia]", err) }
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
      } catch (err: unknown) { console.error("[mia]", err) }
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
    } catch (err: unknown) { console.error("[mia]", err) }
  }
}
