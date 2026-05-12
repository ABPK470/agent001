/**
 * Sync orchestration — builds preview plans and executes them.
 *
 * `previewSync()`: for a given entity, runs the diff engine across every
 * recipe table in parallel, assembles a SyncPlan, persists it.
 *
 * `executeSync()`: takes a planId, re-validates against current source state
 * (>5% drift = abort), opens a target-side transaction, applies inserts /
 * updates / deletes in `executionOrder` (inserts) and `reverseOrder`
 * (deletes), emits SSE-friendly progress events.
 */

import type sql from "mssql"
import sqlMod, { type Transaction } from "mssql"
import { randomUUID } from "node:crypto"
import { getPool } from "../tools/mssql/index.js"
import { detectCatalogDrift, tableHasTriggers } from "./catalog-drift.js"
import { buildDependencyGraph, diffTable } from "./diff-engine.js"
import { getEnvironment } from "./environments.js"
import {
    allocPlanId,
    loadPlan,
    planTooOldToExecute,
    savePlan,
    type SyncPlan,
    type SyncPlanTable,
    type SyncPlanTotals,
} from "./plan-store.js"
import type { SyncRecipeTable } from "./recipes.js"
import { getRecipe, instantiatePredicate, instantiatePredicateWithTree, loadSyncRecipes, selectRecipeTables, type EntityType, type SyncRecipe } from "./recipes.js"

export interface PreviewInput {
  entityType: EntityType
  entityId: string | number
  source: string
  target: string
  /** Allows bypassing the per-table 5M row cap. */
  force?: boolean
  /** Optional FK-only tables explicitly enabled for this preview. */
  enabledOptionalTables?: string[]
}

/**
 * Hard ceiling on how many tables diff in parallel. The mssql pool defaults
 * to max=10 connections per pool; with src+tgt+samples queries each table
 * burns 3-5 conns. Going wider than this exhausts the pool, queues requests,
 * and triggers `Connection is closed` cascades. Override via env if needed.
 */
const PREVIEW_TABLE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env["SYNC_PREVIEW_CONCURRENCY"] ?? "4", 10) || 4,
)

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
function qtable(name: string): string {
  return name.split(".").map((p) => `[${p}]`).join(".")
}

/**
 * Run async tasks with bounded concurrency. Preserves input order in output.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export interface ExecuteProgress {
  type: "started" | "step" | "table-started" | "table-progress" | "table-done" | "completed" | "failed"
  table?: string
  step?: string
  rowsApplied?: number
  rowsTotal?: number
  message?: string
  error?: string
}

let _projectRoot: string | null = null

/** Configure the project root used to load sync-recipes.json. */
export function configureSyncOrchestrator(projectRoot: string): void {
  _projectRoot = projectRoot
}

function projectRoot(): string {
  if (!_projectRoot) throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(projectRoot)")
  return _projectRoot
}

// ── Event stream ─────────────────────────────────────────────────
//
// Sync ops happen outside agent runs, so they don't have a runId/run-scoped
// log channel. Instead, all events flow through `emitSyncEvent()` (see
// sync-events.ts) which the server wires to broadcast() → WS/SSE clients +
// event_log table + webhook drains.
//
// Event types emitted (each preview/execute shares one correlation key):
//   sync.preview.started      { previewId, entityType, entityId, source, target, force }
//   sync.preview.table.start  { previewId, table, predicate }
//   sync.preview.table.done   { previewId, table, counts, durationMs }
//   sync.preview.table.failed { previewId, table, error }
//   sync.preview.sql          { opId, label, connection, sql, durationMs, rowCount, attempts, error? }
//   sync.preview.completed    { previewId, planId, totals, failedTables, durationMs }
//   sync.preview.failed       { previewId, error }
//   sync.execute.started      { planId, source, target, actor, totals }
//   sync.execute.table.start  { planId, table, op, rowsTotal }
//   sync.execute.table.done   { planId, table, op, rowsApplied }
//   sync.execute.sql          { opId, label, connection, sql, durationMs, rowCount, attempts, error? }
//   sync.execute.archive.probe { planId, table, hasTriggers, durationMs }
//   sync.execute.completed    { planId, durationMs }
//   sync.execute.failed       { planId, error, durationMs }
//
// Console + audit_log are written independently — they serve different
// audiences (debug stack traces / actor-attributed compliance trail).

import { emitSyncEvent as emit, emitSyncSqlEvent, runWithSyncContext } from "./sync-events.js"
import { getSyncRunSink } from "./sync-run-sink.js"
export { setSyncEventSink, type SyncEvent, type SyncEventSink } from "./sync-events.js"
export { setSyncRunSink, type SyncRunFinishInput, type SyncRunSink, type SyncRunStartInput } from "./sync-run-sink.js"

// ── SQL telemetry helper ─────────────────────────────────────────
//
// Wraps a `.query()` call with timing + emits a `sync.<kind>.sql` event so
// per-query duration is observable for the execute path (the preview path
// already has equivalent telemetry inside diff-engine.ts via
// runQueryWithRetry).
async function trackedQuery<T = unknown>(
  req: { query: (sql: string) => Promise<sql.IResult<T>> },
  sqlText: string,
  label: string,
  connection: string,
): Promise<sql.IResult<T>> {
  const t0 = Date.now()
  try {
    const result = await req.query(sqlText)
    emitSyncSqlEvent({
      label,
      connection,
      sql: sqlText,
      durationMs: Date.now() - t0,
      rowCount: result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
      attempts: 1,
    })
    return result
  } catch (e) {
    emitSyncSqlEvent({
      label,
      connection,
      sql: sqlText,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

/** Same as trackedQuery but for `.execute(sproc)` calls. */
async function trackedExecute(
  req: { execute: (sproc: string) => Promise<sql.IProcedureResult<unknown>> },
  sprocName: string,
  label: string,
  connection: string,
): Promise<sql.IProcedureResult<unknown>> {
  const t0 = Date.now()
  try {
    const result = await req.execute(sprocName)
    emitSyncSqlEvent({
      label,
      connection,
      sql: `EXEC ${sprocName}`,
      durationMs: Date.now() - t0,
      rowCount: result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
      attempts: 1,
    })
    return result
  } catch (e) {
    emitSyncSqlEvent({
      label,
      connection,
      sql: `EXEC ${sprocName}`,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

// ── Preview ──────────────────────────────────────────────────────


export async function previewSync(input: PreviewInput): Promise<SyncPlan> {
  const previewId = randomUUID()
  const t0 = Date.now()
  emit("sync.preview.started", {
    previewId,
    entityType: input.entityType,
    entityId: input.entityId,
    source: input.source,
    target: input.target,
    force: Boolean(input.force),
  })

  // runWithSyncContext threads {kind, opId, source, target} via AsyncLocalStorage
  // so every SQL query fired inside this scope (in diff-engine, sample readers,
  // PK lookup, display-name lookup) can attribute its `sync.preview.sql` event
  // to this previewId without us having to plumb the id through every helper.
  return runWithSyncContext(
    { kind: "preview", opId: previewId, source: input.source, target: input.target },
    () => previewSyncInner(input, previewId, t0),
  )
}

async function previewSyncInner(input: PreviewInput, previewId: string, t0: number): Promise<SyncPlan> {
  try {
    const bundle = loadSyncRecipes(projectRoot())
    const fullRecipe = getRecipe(bundle, input.entityType)
    const selection = selectRecipeTables(fullRecipe, input.enabledOptionalTables)
    const selectedTableNames = new Set(selection.tables.map((table) => table.name))
    const recipe: SyncRecipe = {
      ...fullRecipe,
      tables: selection.tables,
      executionOrder: selection.executionOrder,
      reverseOrder: selection.reverseOrder,
      archiveTables: fullRecipe.archiveTables.filter((_, index) => selectedTableNames.has(fullRecipe.tables[index]?.name ?? "")),
    }

    // Validate environments
    const sourceEnv = getEnvironment(input.source)
    const targetEnv = getEnvironment(input.target)
    if (sourceEnv.role === "target") throw new Error(`Environment "${sourceEnv.name}" is target-only — cannot use as source.`)
    if (targetEnv.role === "source") throw new Error(`Environment "${targetEnv.name}" is source-only — cannot use as target.`)
    // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
    if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
      throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
    }

    // Resolve entity display name
    const displayName = await fetchEntityDisplayName(recipe, input.entityId, input.source)

    // Tree expansion: when the recipe root table has a self-referencing FK
    // (e.g. core.Rule.parentRuleId → core.Rule.ruleId), expand the single
    // entity ID to the full descendant tree. Predicates using {ids} will
    // receive the complete set; {id} still binds to the root entity only.
    const expandedIds = recipe.selfJoinColumn
      ? await expandTreeIds(recipe, input.entityId, input.source)
      : null

    // Preflight: catalog drift restricted to recipe tables. Surfaces missing
    // tables / columns / type mismatches as warnings — does NOT block preview
    // (so the user can still see the diff and understand what's broken). The
    // execute path uses the same check as a HARD refusal.
    let preflight: { catalogCompatible: boolean; issues: string[] }
    try {
      preflight = await detectCatalogDrift(
        input.source,
        input.target,
        recipe.tables.map((t) => t.name),
      )
    } catch (e) {
      preflight = {
        catalogCompatible: false,
        issues: [`Catalog drift check failed: ${e instanceof Error ? e.message : String(e)}`],
      }
    }

    // Per-table diff with bounded concurrency. Going wider exhausts the mssql
    // pool and produces "Connection is closed" cascades that flap classification
    // between runs (a failed table reports counts:0/0/0/0 instead of its real
    // unchanged count, so totals jitter from one preview to the next).
    const pkColumnsByTable = await fetchPkColumns(input.source, recipe.tables.map((t) => t.name))
    const tableResults: SyncPlanTable[] = await mapWithConcurrency(
      recipe.tables,
      PREVIEW_TABLE_CONCURRENCY,
      async (t: SyncRecipeTable) => {
        const tableT0 = Date.now()
        const predicate = expandedIds
          ? instantiatePredicateWithTree(t.predicate, input.entityId, expandedIds)
          : instantiatePredicate(t.predicate, input.entityId)
        emit("sync.preview.table.start", { previewId, table: t.name, predicate })
        try {
          const r = await diffTable(
            recipe,
            t,
            input.entityId,
            input.source,
            input.target,
            pkColumnsByTable.get(t.name) ?? [],
            { rowCap: input.force ? Number.MAX_SAFE_INTEGER : undefined, expandedIds },
          )
          emit("sync.preview.table.done", {
            previewId, table: t.name, counts: r.counts, durationMs: r.diffDurationMs,
          })
          return r
        } catch (e: unknown) {
          // Log the full error (with stack) to server logs — the .catch
          // would otherwise swallow it into a single-line warning string.
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error(`[sync.preview] diffTable(${t.name}) failed after retries:`, e)
          emit("sync.preview.table.failed", { previewId, table: t.name, error: errMsg })
          return {
            table: t.name,
            scopePredicate: predicate,
            counts: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 },
            samples: { insert: [], update: [], delete: [] },
            conflicts: [],
            warnings: [`Diff failed: ${errMsg}`],
            diffDurationMs: Date.now() - tableT0,
          } as SyncPlanTable
        }
      },
    )

    const totals: SyncPlanTotals = tableResults.reduce(
      (acc: SyncPlanTotals, t: SyncPlanTable) => ({
        insert: acc.insert + t.counts.insert,
        update: acc.update + t.counts.update,
        delete: acc.delete + t.counts.delete,
        unchanged: acc.unchanged + t.counts.unchanged,
        lowConfidence: acc.lowConfidence + t.counts.lowConfidence,
        conflicts: acc.conflicts + t.counts.conflicts,
        tablesCount: acc.tablesCount + (t.counts.insert + t.counts.update + t.counts.delete + t.counts.conflicts > 0 ? 1 : 0),
      }),
      { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 },
    )

    const warnings: string[] = []
    for (const d of recipe.discrepancies) warnings.push(`[${d.kind}] ${d.table}: ${d.note}`)
    for (const issue of preflight.issues) warnings.push(`[drift] ${issue}`)
    const disabledOptionalTables = fullRecipe.tables
      .filter((table) => table.userControllable && !selectedTableNames.has(table.name))
      .map((table) => table.name)
    if (disabledOptionalTables.length > 0) {
      warnings.unshift(
        `FK-only tables excluded by default: ${disabledOptionalTables.join(", ")}. Enable them explicitly to include closure-only rows in the preview.`,
      )
    }

    // Surface diff failures at the plan level so the UI can show "preview is
    // unreliable, retry" prominently instead of users having to expand each
    // failed table to spot the per-row warning.
    const failedTables = tableResults.filter((t) => t.warnings.some((w) => w.startsWith("Diff failed:")))
    if (failedTables.length > 0) {
      warnings.unshift(
        `Preview incomplete: ${failedTables.length}/${tableResults.length} table(s) failed to diff (${failedTables.map((t) => t.table).join(", ")}). ` +
        `Totals shown EXCLUDE these tables and will jitter between runs. Re-run the preview.`,
      )
    }

    const plan: SyncPlan = {
      planId: allocPlanId(),
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      entity: { type: input.entityType, id: input.entityId, displayName },
      source: input.source,
      target: input.target,
      preflight, // computed above from detectCatalogDrift restricted to recipe.tables
      tables: tableResults,
      totals,
      dependencyGraph: buildDependencyGraph(recipe, tableResults),
      warnings,
      estimatedDurationSec: Math.max(2, Math.ceil((totals.insert + totals.update + totals.delete) / 500)),
      recipeSnapshot: {
        entityType: recipe.entityType,
        rootTable: recipe.rootTable,
        rootKeyColumn: recipe.rootKeyColumn,
        legacyPipelineId: recipe.legacyPipelineId ?? undefined,
        tables: recipe.tables.map((t: SyncRecipeTable) => ({ name: t.name, scopeColumn: t.scopeColumn, predicate: t.predicate })),
        executionOrder: recipe.executionOrder,
        reverseOrder: recipe.reverseOrder,
        enabledOptionalTables: recipe.tables.filter((table) => table.userControllable).map((table) => table.name),
      },
    }
    savePlan(plan)

    emit("sync.preview.completed", {
      previewId,
      planId: plan.planId,
      entityType: input.entityType,
      entityId: input.entityId,
      source: input.source,
      target: input.target,
      totals,
      failedTables: failedTables.map((t) => t.table),
      durationMs: Date.now() - t0,
    })

    return plan
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    emit("sync.preview.failed", {
      previewId,
      entityType: input.entityType,
      entityId: input.entityId,
      source: input.source,
      target: input.target,
      error: errMsg,
      durationMs: Date.now() - t0,
    })
    throw e
  }
}

// ── Execute ──────────────────────────────────────────────────────

export interface ExecuteOptions {
  confirm: boolean
  /** Optional progress callback (used by SSE route). */
  onProgress?: (p: ExecuteProgress) => void
  /** Identity of the user requesting execute (for safety rails / audit). */
  userUpn?: string | null
}

export async function executeSync(planId: string, opts: ExecuteOptions): Promise<{ planId: string; success: boolean; error?: string }> {
  if (!opts.confirm) throw new Error("executeSync requires explicit confirm=true.")
  const plan = loadPlan(planId)
  if (!plan) throw new Error(`Plan ${planId} not found or expired.`)
  if (planTooOldToExecute(plan)) throw new Error(`Plan ${planId} is older than 1 hour — re-preview before executing.`)

  // Safety: target writeEnabled
  const targetEnv = getEnvironment(plan.target)
  if (targetEnv.role === "source") throw new Error(`Target "${targetEnv.name}" is source-only.`)
  // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
  if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
    throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
  }
  if (targetEnv.syncAllowlist.length && (!opts.userUpn || !targetEnv.syncAllowlist.includes(opts.userUpn))) {
    throw new Error(`User ${opts.userUpn ?? "<anonymous>"} is not in sync allowlist for "${targetEnv.name}".`)
  }

  // Hard refusal on catalog drift (preview surfaces it as warning; execute treats it as fatal).
  const drift = await detectCatalogDrift(
    plan.source,
    plan.target,
    plan.recipeSnapshot.tables.map((t) => t.name),
  )
  if (!drift.catalogCompatible) {
    throw new Error(
      `Catalog drift detected — refusing to execute. ${drift.issues.length} issue(s):\n` +
      drift.issues.slice(0, 10).map((i) => `  • ${i}`).join("\n") +
      (drift.issues.length > 10 ? `\n  … and ${drift.issues.length - 10} more` : ""),
    )
  }

  // Hard refusal on scope-misattribution conflicts. Inserting a row whose PK
  // already exists on target (under a different parent) would PK-violate and
  // roll back the whole transaction. Refusing here gives the operator an
  // actionable error pointing at the offending rows.
  const conflictedTables = plan.tables.filter((t) => t.counts.conflicts > 0)
  if (conflictedTables.length > 0) {
    const total = conflictedTables.reduce((a, t) => a + t.counts.conflicts, 0)
    const sampleLines = conflictedTables.flatMap((t) =>
      t.conflicts.slice(0, 3).map((c) => `  • ${t.table}: ${c.summary}`),
    ).slice(0, 10)
    throw new Error(
      `Scope misattribution — refusing to execute. ${total} row(s) across ` +
      `${conflictedTables.length} table(s) exist on target under a different parent than source expects:\n` +
      sampleLines.join("\n") +
      `\nFix the target metadata (re-attach these rows to the correct parent) and re-preview.`,
    )
  }

  // Persist run start (best-effort — sink no-ops in tests).
  try {
    getSyncRunSink().start({
      planId,
      entityType: plan.entity.type,
      entityId: plan.entity.id,
      entityDisplayName: plan.entity.displayName,
      source: plan.source,
      target: plan.target,
      actorUpn: opts.userUpn ?? null,
      previewTotals: plan.totals,
    })
  } catch (e) { console.warn(`[sync.execute] sink.start failed:`, e) }

  const onProgress = opts.onProgress ?? (() => {})
  const execT0 = Date.now()
  onProgress({ type: "started", message: `Executing plan ${planId} → ${plan.target}` })
  emit("sync.execute.started", {
    planId, source: plan.source, target: plan.target,
    actor: opts.userUpn ?? null,
    totals: plan.totals,
  })

  // Same ALS pattern as previewSync — every SQL query inside this scope gets
  // attributed to this planId via `sync.execute.sql` events.
  return runWithSyncContext(
    { kind: "execute", opId: planId, source: plan.source, target: plan.target },
    () => executeSyncInner(plan, planId, opts, onProgress, execT0),
  )
}

async function executeSyncInner(
  plan: SyncPlan,
  planId: string,
  opts: ExecuteOptions,
  onProgress: (p: ExecuteProgress) => void,
  execT0: number,
): Promise<{ planId: string; success: boolean; error?: string }> {
  // Load PK columns once
  const pkByTable = await fetchPkColumns(plan.source, plan.recipeSnapshot.tables.map((t) => t.name))

  // Drift re-validation
  const driftPct = await revalidatePlanDrift(plan)
  if (driftPct !== null && driftPct > DRIFT_ABORT_PCT) {
    const msg = `Plan drift ${(driftPct * 100).toFixed(1)}% exceeds ${(DRIFT_ABORT_PCT * 100).toFixed(0)}% threshold — re-preview before executing.`
    onProgress({ type: "failed", error: msg })
    emit("sync.execute.failed", { planId, error: msg, durationMs: Date.now() - execT0, driftPct })
    try { getSyncRunSink().finish({ planId, status: "failed", error: msg, driftDetectedPct: driftPct, durationMs: Date.now() - execT0 }) } catch { /* ignore */ }
    return { planId, success: false, error: msg }
  }
  void opts

  const { pool: tgtPool } = await getPool(plan.target)
  const { pool: srcPool } = await getPool(plan.source)
  if (!tgtPool) throw new Error(`Target pool unavailable.`)

  const entityId = plan.entity.id
  const entityType = plan.recipeSnapshot.entityType
  const isContract = entityType === "contract"
  const tgtEnv = getEnvironment(plan.target)
  const linkedService = tgtEnv?.linkedServiceName ?? "ABI - SYNC"

  // Non-fatal step failures (target-side sproc errors) are accumulated here
  // and surfaced on the completion event so the UI doesn't show a clean run
  // when something silently failed.
  const stepWarnings: { step: string; sproc: string; error: string }[] = []

  // Helper: call a target-side sproc, best-effort. Non-fatal failures log + warn.
  async function callTargetSproc(sprocName: string, params: Record<string, unknown>, stepName: string): Promise<boolean> {
    try {
      const req = tgtPool.request()
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "number") req.input(k, sqlMod.Int, v)
        else if (typeof v === "boolean") req.input(k, sqlMod.Bit, v)
        else req.input(k, sqlMod.NVarChar(4000), v == null ? null : String(v))
      }
      await trackedExecute(req, sprocName, `callTargetSproc(${stepName}/${sprocName})`, plan.target)
      return true
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} (${sprocName}) failed:`, e)
      stepWarnings.push({ step: stepName, sproc: sprocName, error: errMsg })
      // Surface to live event log + structured event so the UI can render it.
      onProgress({ type: "step", step: stepName, message: `${stepName} (${sprocName}) failed`, error: errMsg })
      emit("sync.execute.step.failed", { planId, step: stepName, sproc: sprocName, error: errMsg })
      return false
    }
  }

  // Helper: emit a step progress event
  function step(name: string, message?: string) {
    onProgress({ type: "step", step: name, message: message ?? name })
    emit("sync.execute.step", { planId, step: name })
  }

  const tx = new sqlMod.Transaction(tgtPool)
  const appliedTotals = { insert: 0, update: 0, delete: 0 }
  const allTables = plan.recipeSnapshot.executionOrder
  try {
    // ═══════════════════════════════════════════════════════════
    // Pipeline lifecycle — mirrors pipeline 788 activity sequence
    // ═══════════════════════════════════════════════════════════

    // ── Step 1: Audit pre-check (seq 1) ──
    step("audit-check", "Pre-sync audit check")
    await callTargetSproc("core.uspAuditRunCheck", {
      action: "syncOrNot", objType: entityType === "contract" ? "Contract" : entityType, id: entityId,
    }, "audit-check")

    // ── Step 2: Handle dependencies (seq 2) — contract only ──
    if (isContract) {
      step("dependencies", "Checking dependencies")
      await callTargetSproc("core.uspObjectDependencies", {
        id: entityId, objectName: entityType,
      }, "dependencies")
    }

    // ── Step 3: Lock entity for sync (seq 3) ──
    step("lock", `Locking ${entityType}`)
    if (isContract) {
      await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: true }, "lock")
    }

    // ── Pre-flight: batch-probe target triggers for ALL upsert tables ──
    //
    // Why this lives OUTSIDE the transaction:
    //   `maybeArchive` previously called `tableHasTriggers(plan.target, ...)`
    //   per-table from inside the open tx. That helper takes a SEPARATE
    //   pool connection and queries `sys.triggers JOIN sys.objects`. While
    //   the tx is open it holds Sch-M locks (NOCHECK CONSTRAINT promotes
    //   to Sch-M on the parent table) so the probe blocks on Sch-S and
    //   sits at the connection's lock_timeout (~60s) before returning
    //   `false`. Eight probed tables = ~8 minutes of dead time per sync.
    //
    // The fix: one query, before tx.begin(), populates a Map that
    // `maybeArchive` reads from instead of re-probing.
    const upsertTables = plan.recipeSnapshot.executionOrder.filter((tn) => {
      const tr = plan.tables.find((t) => t.table === tn)
      return tr && tr.counts.insert + tr.counts.update > 0
    })
    const triggerCache = new Map<string, boolean>()
    if (upsertTables.length > 0) {
      const probeT0 = Date.now()
      try {
        const pairs = upsertTables.map((tn) => {
          const [s, n] = tn.split(".")
          return `('${(s ?? "").replace(/'/g, "''")}','${(n ?? "").replace(/'/g, "''")}')`
        }).join(",")
        const sqlText =
          `WITH wanted(s,n) AS (SELECT * FROM (VALUES ${pairs}) v(s,n)) ` +
          `SELECT s.name AS schemaName, o.name AS tableName, ` +
          `  COUNT(t.object_id) AS triggerCount ` +
          `FROM wanted w ` +
          `JOIN sys.schemas s ON s.name = w.s ` +
          `JOIN sys.objects o ON o.schema_id = s.schema_id AND o.name = w.n ` +
          `LEFT JOIN sys.triggers t ON t.parent_id = o.object_id AND t.is_disabled = 0 ` +
          `GROUP BY s.name, o.name`
        const r = await trackedQuery(tgtPool.request(), sqlText, "trigger-probe.batch", plan.target)
        for (const row of r.recordset as Array<{ schemaName: string; tableName: string; triggerCount: number }>) {
          triggerCache.set(`${row.schemaName}.${row.tableName}`, row.triggerCount > 0)
        }
        emit("sync.execute.archive.probe.batch", {
          planId, tables: upsertTables.length, durationMs: Date.now() - probeT0,
        })
      } catch (e) {
        // Best-effort: if the batch probe fails, the per-table fallback in
        // maybeArchive will still log a skipped event with hasTriggers=false.
        console.warn(`[sync.execute] batch trigger-probe failed:`, e)
      }
    }

    // ── Step 5: Sync metadata in transaction (seq 5) ──
    // This is the core data sync — MERGE all tables within a TX.
    step("sync-metadata", "Syncing metadata rows")
    await tx.begin()

    // Build the set of tables that actually have changes — only these need
    // FK constraint toggling. Avoids expensive WITH CHECK CHECK CONSTRAINT
    // re-validation scans on untouched tables (which can dominate execution
    // time for small syncs).
    const affectedTables = new Set<string>()
    for (const t of plan.tables) {
      if (t.counts.insert + t.counts.update + t.counts.delete > 0) {
        affectedTables.add(t.table)
      }
    }

    // Disable FK constraints only on tables with changes
    for (const t of allTables) {
      if (!affectedTables.has(t)) continue
      try { await trackedQuery(tx.request(), `ALTER TABLE ${qtable(t)} NOCHECK CONSTRAINT ALL`, `nocheck-constraint(${t})`, plan.target) }
      catch (e) { console.warn(`[sync.execute] NOCHECK CONSTRAINT failed for ${t}:`, e) }
    }

    // Inserts + Updates: parents → children
    for (const tableName of plan.recipeSnapshot.executionOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult) continue
      if (tableResult.counts.insert + tableResult.counts.update === 0) continue
      const rowsTotal = tableResult.counts.insert + tableResult.counts.update
      onProgress({ type: "table-started", table: tableName, rowsTotal })
      emit("sync.execute.table.start", { planId, table: tableName, op: "upsert", rowsTotal })
      await maybeArchive(tx, plan, tableName, pkByTable.get(tableName) ?? [], triggerCache)
      const applied = await applyInsertsUpdates(tx, plan, tableName, pkByTable.get(tableName) ?? [])
      appliedTotals.update += applied
      onProgress({ type: "table-done", table: tableName, rowsApplied: applied })
      emit("sync.execute.table.done", { planId, table: tableName, op: "upsert", rowsApplied: applied })
    }

    // Deletes: children → parents
    for (const tableName of plan.recipeSnapshot.reverseOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult || tableResult.counts.delete === 0) continue
      onProgress({ type: "table-started", table: tableName, rowsTotal: tableResult.counts.delete })
      emit("sync.execute.table.start", { planId, table: tableName, op: "delete", rowsTotal: tableResult.counts.delete })
      const applied = await applyDeletes(tx, plan, tableName, pkByTable.get(tableName) ?? [])
      appliedTotals.delete += applied
      onProgress({ type: "table-done", table: tableName, rowsApplied: applied })
      emit("sync.execute.table.done", { planId, table: tableName, op: "delete", rowsApplied: applied })
    }

    // Re-enable FK constraints only on tables we disabled them on
    for (const t of allTables) {
      if (!affectedTables.has(t)) continue
      try { await trackedQuery(tx.request(), `ALTER TABLE ${qtable(t)} WITH CHECK CHECK CONSTRAINT ALL`, `check-constraint(${t})`, plan.target) }
      catch (e) { console.warn(`[sync.execute] CHECK CONSTRAINT failed for ${t}:`, e) }
    }

    await tx.commit()
    step("sync-metadata-done", "Metadata sync committed")

    // ── Step 6: Get pipelineId for contract (seq 6) — contract only ──
    let pipelineIdForContract: number | null = null
    if (isContract) {
      step("get-pipeline-id", "Resolving pipeline for contract")
      try {
        const r = await tgtPool.request()
          .input("contractId", sqlMod.Int, entityId)
          .execute("core.uspGetPipelineIdForContract")
        pipelineIdForContract = r.recordset?.[0]?.pipelineId ?? null
      } catch (e) { console.warn(`[sync.execute] get-pipeline-id failed:`, e) }
    }

    // ── Step 7: Register remote pipeline (seq 11) — contract only ──
    if (isContract && pipelineIdForContract != null) {
      step("register-pipeline", "Registering remote pipeline")
      try {
        await callTargetSproc("core.uspSyncRegisterRemotePipeline", {
          pipelineId: pipelineIdForContract, linkedService,
        }, "register-pipeline")
      } catch (e) { console.warn(`[sync.execute] register-pipeline failed:`, e) }
    }

    // ── Step 8: Undeploy contract on target (seq 20) — contract only ──
    if (isContract) {
      step("undeploy", "Undeploying contract on target")
      await callTargetSproc("core.uspSyncUndeployMarkedContract", { contractId: entityId, linkedService }, "undeploy")
    }

    // ── Step 9: Unlock after undeploy (seq 25) ──
    if (isContract) {
      step("unlock-after-undeploy", "Unlocking after undeploy")
      await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: false }, "unlock-after-undeploy")
    }

    // ── Step 10: Second audit check before deploy (seq 30) ──
    if (isContract) {
      step("audit-check-2", "Pre-deploy audit check")
      await callTargetSproc("core.uspAuditRunCheck", {
        action: "syncOrNot", objType: "Contract", id: entityId,
      }, "audit-check-2")
    }

    // ── Step 11: Lock for deployment (seq 35) ──
    if (isContract) {
      step("lock-for-deploy", "Locking for deployment")
      await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: true }, "lock-for-deploy")
    }

    // ── Step 10: Deploy pre-script (seq 40) ──
    if (isContract) {
      step("deploy-pre-script", "Running pre-deployment scripts")
      await callTargetSproc("core.uspSyncRunContractDeploymentScripts", {
        contractId: entityId, action: "Run preScript", linkedService,
      }, "deploy-pre-script")
    }

    // ── Step 11-15: Create datasets (seq 50-54) — contract only ──
    if (isContract) {
      for (const dsType of ["stage", "archive", "list", "dim", "fact"] as const) {
        step(`create-dataset-${dsType}`, `Creating ${dsType} dataset`)
        await callTargetSproc("core.uspSyncCreateDatasets", {
          contractId: entityId, type: dsType, linkedService,
        }, `create-dataset-${dsType}`)
      }
    }

    // ── Step 16: Create foreign keys (seq 55) ──
    if (isContract) {
      step("create-fks", "Creating foreign keys")
      await callTargetSproc("core.uspSyncCreateDatasetFKs", {
        linkedService, contractId: entityId,
      }, "create-fks")
    }

    // ── Step 17: Deploy ETL2 custom transformation (seq 200) ──
    if (isContract) {
      step("deploy-etl", "Deploying ETL custom transformations")
      await callTargetSproc("core.uspSyncDeployETL2CustomTransformation", {
        contractId: entityId, linkedService,
      }, "deploy-etl")
    }

    // ── Step 18: Deploy routine (seq 300) ──
    if (isContract) {
      step("deploy-routine", "Deploying routines")
      await callTargetSproc("core.uspSyncDeployRoutine", {
        contractId: entityId, linkedService,
      }, "deploy-routine")
    }

    // ── Step 19: Deploy post-script (seq 400) ──
    if (isContract) {
      step("deploy-post-script", "Running post-deployment scripts")
      await callTargetSproc("core.uspSyncRunContractDeploymentScripts", {
        contractId: entityId, action: "Run postScript", linkedService,
      }, "deploy-post-script")
    }

    // ── Step 20: Unlock after deployment (seq 900) ──
    if (isContract) {
      step("unlock-after-deploy", "Unlocking after deployment")
      await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: false }, "unlock-after-deploy")
    }

    // ── Step 23: Set sync date at source (seq 999) ──
    step("set-sync-date", "Updating sync date on source")
    try {
      const srcReq = srcPool.request()
      srcReq.input("action", sqlMod.NVarChar(100), "syncDate")
      srcReq.input("id", typeof entityId === "number" ? sqlMod.Int : sqlMod.NVarChar(400), entityId)
      srcReq.input("objType", sqlMod.NVarChar(100), isContract ? "Contract" : entityType)
      await srcReq.execute("core.uspAuditRunCheck")
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] syncDate update failed:`, e)
      stepWarnings.push({ step: "set-sync-date", sproc: "core.uspAuditRunCheck", error: errMsg })
      onProgress({ type: "step", step: "set-sync-date", message: "set-sync-date (core.uspAuditRunCheck) failed", error: errMsg })
      emit("sync.execute.step.failed", { planId, step: "set-sync-date", sproc: "core.uspAuditRunCheck", error: errMsg })
    }

    // ── Step 24: Update deployment date on target (seq 1000) ──
    // Ensure LOCAL_SERVER linked server has RPC enabled — uspSyncAuditRunCheck
    // uses it internally.  Best-effort: if the server doesn't exist or we lack
    // permission the sproc will simply fail with a warning as before.
    try {
      await tgtPool.request().query(`
        IF EXISTS (SELECT 1 FROM sys.servers WHERE name = 'LOCAL_SERVER')
        BEGIN
          EXEC sp_serveroption 'LOCAL_SERVER', 'rpc', 'true'
          EXEC sp_serveroption 'LOCAL_SERVER', 'rpc out', 'true'
        END
      `)
    } catch (e) {
      console.warn("[sync.execute] Could not configure LOCAL_SERVER RPC (non-fatal):", e)
    }
    step("set-deploy-date", "Updating deployment date on target")
    try {
      await callTargetSproc("core.uspSyncAuditRunCheck", {
        action: "deployDate", id: entityId,
        objType: isContract ? "Contract" : entityType, linkedService,
      }, "set-deploy-date")
    } catch (e) { console.warn(`[sync.execute] deployDate update failed:`, e) }

    // ═══════════════════════════════════════════════════════════
    // Success (possibly with warnings)
    // ═══════════════════════════════════════════════════════════
    const hasStepFailures = stepWarnings.length > 0
    const completedMsg = !hasStepFailures
      ? `Plan ${planId} applied successfully.`
      : `Plan ${planId} completed with ${stepWarnings.length} step failure(s): ${stepWarnings.map((w) => `${w.step} — ${w.error}`).join("; ")}`
    const stepErrorSummary = hasStepFailures
      ? stepWarnings.map((w) => `${w.step}: ${w.error}`).join("; ")
      : undefined
    onProgress({ type: "completed", message: completedMsg })
    emit("sync.execute.completed", { planId, durationMs: Date.now() - execT0, applied: appliedTotals, warnings: stepWarnings })
    try {
      getSyncRunSink().finish({
        planId,
        // Any step failure = failed run. Data may have been applied but the
        // pipeline didn't complete cleanly — never show this as success.
        status: hasStepFailures ? "failed" : "success",
        error: stepErrorSummary,
        executeTotals: appliedTotals,
        driftDetectedPct: driftPct,
        durationMs: Date.now() - execT0,
      })
    } catch (e) { console.warn(`[sync.execute] sink.finish failed:`, e) }
    return { planId, success: !hasStepFailures, error: stepErrorSummary }
  } catch (e) {
    // Re-enable FK constraints even on failure — best-effort
    for (const t of allTables) {
      try { await tx.request().query(`ALTER TABLE ${qtable(t)} WITH CHECK CHECK CONSTRAINT ALL`) }
      catch { /* tx may already be aborted */ }
    }
    try { await tx.rollback() } catch { /* ignore */ }

    // Unlock the entity on failure to avoid leaving it locked
    if (isContract) {
      try { await tgtPool.request().input("contractId", sqlMod.Int, entityId).input("isLocked", sqlMod.Bit, false).execute("core.uspSetContractLock") }
      catch { /* best-effort */ }
    }

    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[sync.execute] plan ${planId} failed:`, e)
    onProgress({ type: "failed", error: msg })
    emit("sync.execute.failed", { planId, error: msg, durationMs: Date.now() - execT0 })
    try { getSyncRunSink().finish({ planId, status: "failed", error: msg, driftDetectedPct: driftPct, durationMs: Date.now() - execT0 }) }
    catch { /* ignore */ }
    return { planId, success: false, error: msg }
  }
}

/** Maximum tolerated drift between preview and current source row counts. */
const DRIFT_ABORT_PCT = 0.05

/**
 * Re-validate the plan against the CURRENT source state by re-counting rows
 * for every table with non-zero diff in the preview. Returns the maximum
 * relative drift (0 = perfect match) or null when nothing to check.
 *
 * Cheap: one COUNT(*) per affected table; bounded by recipe size.
 */
async function revalidatePlanDrift(plan: SyncPlan): Promise<number | null> {
  const affected = plan.tables.filter(
    (t) => t.counts.insert + t.counts.update + t.counts.delete > 0,
  )
  if (affected.length === 0) return null
  const { pool } = await getPool(plan.source)
  let maxDrift = 0
  for (const t of affected) {
    try {
      const r = await pool.request().query(
        `SELECT COUNT(*) AS cnt FROM ${qtable(t.table)} WITH (NOLOCK) WHERE ${t.scopePredicate}`,
      )
      const currentCount = (r.recordset[0]?.cnt as number | undefined) ?? 0
      // Reference: source rows expected = unchanged + insert + update (everything in source scope).
      const expected = t.counts.unchanged + t.counts.insert + t.counts.update
      if (expected === 0) continue
      const drift = Math.abs(currentCount - expected) / Math.max(expected, 1)
      if (drift > maxDrift) maxDrift = drift
    } catch (e) {
      console.warn(`[sync.drift-revalidate] ${t.table}: ${e instanceof Error ? e.message : e}`)
    }
  }
  emit("sync.execute.drift.revalidated", { planId: plan.planId, maxDriftPct: maxDrift })
  return maxDrift
}

/**
 * Optional archive write before mutating a table. Honors ABI's documented
 * convention: if the target table already has active AFTER triggers, the
 * triggers handle archive — we skip. Otherwise we attempt a snapshot copy
 * of rows about-to-change into the archive sibling table (when one exists).
 *
 * Best-effort: failures here NEVER abort the sync (logged as a warning).
 * The trigger-based path is the production-default per the original plan.
 */
async function maybeArchive(
  _tx: Transaction,
  plan: SyncPlan,
  tableName: string,
  _pkColumns: string[],
  triggerCache?: Map<string, boolean>,
): Promise<void> {
  // Resolve archive sibling for this table.
  const tIdx = plan.recipeSnapshot.tables.findIndex((rt) => rt.name === tableName)
  if (tIdx < 0) return
  // archiveTables may not exist on the recipe snapshot (older plans) — bail.
  // Real archive copy needs a column list and SCD2-aware WHERE clauses that
  // we cannot derive without live schema introspection inside the tx; the
  // safer default (and the documented production convention) is to rely on
  // target-side triggers. We probe once and emit a warning when neither
  // path is wired so the operator knows whether SCD2 history is captured.
  try {
    // Prefer the pre-flight cache; fall back to a live probe only when the
    // batch query failed (rare) or the cache wasn't supplied.
    let hasTriggers: boolean
    let cached: boolean
    const probeT0 = Date.now()
    if (triggerCache && triggerCache.has(tableName)) {
      hasTriggers = triggerCache.get(tableName)!
      cached = true
    } else {
      hasTriggers = await tableHasTriggers(plan.target, tableName)
      cached = false
    }
    emit("sync.execute.archive.probe", {
      planId: plan.planId,
      table: tableName,
      hasTriggers,
      cached,
      durationMs: Date.now() - probeT0,
    })
    if (!hasTriggers) {
      emit("sync.execute.archive.skipped", {
        planId: plan.planId,
        table: tableName,
        reason:
          "target has no active triggers and engine-side archive not yet implemented — SCD2 history will NOT be captured for this run",
      })
    }
  } catch (e) {
    console.warn(`[sync.archive] trigger-probe failed for ${tableName}:`, e)
  }
}

// ── Self-join tree expansion ─────────────────────────────────────

/**
 * Expand a single entity ID to the full descendant tree via recursive CTE.
 *
 * Used when `recipe.selfJoinColumn` is set (e.g. `parentRuleId` on `core.Rule`).
 * Returns all IDs in the tree (root + all descendants). The result is substituted
 * into `{ids}` placeholders in recipe predicates so the diff captures the full
 * hierarchy — matching the behavior of legacy stored procedures that walk the
 * self-referencing FK with a recursive CTE.
 *
 * Runs against the SOURCE environment (the tree structure we want to replicate).
 */
async function expandTreeIds(
  recipe: SyncRecipe,
  entityId: string | number,
  source: string,
): Promise<Array<string | number>> {
  if (!recipe.selfJoinColumn) return [entityId]
  const { pool } = await getPool(source)
  const pk = recipe.rootKeyColumn
  const fk = recipe.selfJoinColumn
  const table = qtable(recipe.rootTable)
  const idParam = typeof entityId === "number" ? sqlMod.Int : sqlMod.NVarChar(400)
  const r = await pool.request()
    .input("rootId", idParam, entityId)
    .query(`
      ;WITH tree AS (
        SELECT [${pk}] FROM ${table} WHERE [${pk}] = @rootId
        UNION ALL
        SELECT child.[${pk}] FROM ${table} child
        INNER JOIN tree parent ON child.[${fk}] = parent.[${pk}]
      )
      SELECT [${pk}] AS id FROM tree
      OPTION (MAXRECURSION 100)
    `)
  const ids = r.recordset.map((row: Record<string, unknown>) => row.id as string | number)
  if (ids.length === 0) return [entityId] // root not found — fall back to single id
  return ids
}

// ── Entity search ────────────────────────────────────────────────

export interface EntitySearchResult {
  id: string | number
  name: string | null
}

/**
 * Search for entities by name in the root table of a recipe.
 * Returns up to `limit` matches from the source environment.
 */
export async function searchEntities(
  entityType: EntityType,
  source: string,
  query: string,
  limit = 200,
): Promise<EntitySearchResult[]> {
  const recipe = getRecipe(loadSyncRecipes(projectRoot()), entityType)
  if (!recipe.rootNameColumn) return []
  const { pool } = await getPool(source)
  const safeLike = query.replace(/[%_[\]^]/g, "[$&]")
  const r = await pool.request()
    .input("q", sqlMod.NVarChar(400), `%${safeLike}%`)
    .input("limit", sqlMod.Int, Math.min(limit, 500))
    .query(`
      SELECT TOP (@limit)
        [${recipe.rootKeyColumn}] AS id,
        [${recipe.rootNameColumn}] AS name
      FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
      WHERE [${recipe.rootNameColumn}] LIKE @q
      ORDER BY [${recipe.rootNameColumn}]
    `)
  return r.recordset.map((row: Record<string, unknown>) => ({
    id: row.id as string | number,
    name: (row.name as string | null) ?? null,
  }))
}

// ── Helpers ──────────────────────────────────────────────────────

async function fetchEntityDisplayName(recipe: ReturnType<typeof getRecipe>, entityId: string | number, source: string): Promise<string | null> {
  if (!recipe.rootNameColumn) return null
  try {
    const { pool } = await getPool(source)
    const r = await pool.request().query(`
      SELECT TOP 1 [${recipe.rootNameColumn}] AS displayName
      FROM ${qtable(recipe.rootTable)} WITH (NOLOCK)
      WHERE [${recipe.rootKeyColumn}] = ${typeof entityId === "number" ? entityId : `'${String(entityId).replace(/'/g, "''")}'`}
    `)
    return (r.recordset[0]?.displayName as string | undefined) ?? null
  } catch {
    return null
  }
}

async function fetchPkColumns(connection: string, tables: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (tables.length === 0) return result
  const { pool } = await getPool(connection)
  for (const qn of tables) {
    const [schema, name] = qn.split(".")
    if (!schema || !name) continue
    try {
      const r = await pool.request().query(`
        SELECT c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c        ON c.object_id  = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
          AND i.object_id = OBJECT_ID('${schema}.${name}')
        ORDER BY ic.key_ordinal
      `)
      result.set(qn, r.recordset.map((row: { name: string }) => row.name))
    } catch {
      result.set(qn, [])
    }
  }
  return result
}

/**
 * Columns excluded from MERGE UPDATE SET / INSERT VALUES — mirrors the legacy
 * core.uspSyncObjectTran exclusion list. These are managed columns that get
 * set explicitly (validFrom = GETUTCDATE(), validTo = NULL) rather than
 * blindly copied from the source environment.
 */
const SYNC_META_COLUMNS = new Set([
  "validFrom",
  "validTo",
  "isLocked",
  "syncDate",
  "deployDate",
])

/**
 * Apply inserts + updates by reading source rows via the source pool and
 * writing them to the target via a temp table + MERGE.
 * No linked-server dependency — uses direct connection pools.
 *
 * Uses MERGE (not DELETE+INSERT) because parent rows may have FK references
 * from child tables that prevent deletion.
 *
 * Meta columns (validFrom, validTo, isLocked, syncDate, deployDate) are NOT
 * copied from source — instead validFrom=GETUTCDATE(), validTo=NULL on both
 * INSERT and UPDATE, matching the legacy core.uspSyncObjectTran behaviour.
 */
async function applyInsertsUpdates(tx: Transaction, plan: SyncPlan, tableName: string, pkColumns: string[]): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  const predicate = tableResult.scopePredicate
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot MERGE.`)

  // 1. Read source rows via source pool (direct connection, no linked server).
  const { pool: srcPool } = await getPool(plan.source)
  const srcResult = await trackedQuery(
    srcPool.request(),
    `SELECT * FROM ${qtable(tableName)} WHERE ${predicate}`,
    `applyInsertsUpdates.read(${tableName})`,
    plan.source,
  )
  const rows = srcResult.recordset as Record<string, unknown>[]
  if (rows.length === 0) return 0

  // 2. Discover columns from target metadata (not source row keys — schemas may diverge).
  const colResult = await trackedQuery(
    tx.request(),
    `
    SELECT c.name, c.is_identity, c.is_computed
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
    ORDER BY c.column_id
  `,
    `applyInsertsUpdates.cols(${tableName})`,
    plan.target,
  )
  const targetCols = colResult.recordset as Array<{ name: string; is_identity: boolean; is_computed: boolean }>
  const identityCol = targetCols.find((c) => c.is_identity)?.name ?? null
  const allSourceCols = new Set(Object.keys(rows[0]))

  // Which target columns actually exist in source?
  const allSyncCols = targetCols
    .filter((c) => allSourceCols.has(c.name) && !c.is_computed)
    .map((c) => c.name)

  // Temp table: ALL overlapping columns including identity (for PK joins)
  // but excluding meta columns (we never copy them from source).
  const tempCols = allSyncCols.filter((c) => !SYNC_META_COLUMNS.has(c))
  if (tempCols.length === 0) throw new Error(`No overlapping data columns for ${tableName}.`)

  // Columns for the MERGE UPDATE SET — exclude PK (can't update), identity, meta
  const pkSet = new Set(pkColumns)
  const updateCols = tempCols.filter((c) => !pkSet.has(c) && c !== identityCol)

  // Does the target have validFrom / validTo columns?
  const hasValidFrom = allSyncCols.includes("validFrom")
  const hasValidTo = allSyncCols.includes("validTo")

  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")

  // 3. Build temp table, insert source rows, then MERGE — all in one batch.
  const BATCH = 500
  const batches: string[] = []
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const valuesList = batch.map((row) => {
      const vals = tempCols.map((c) => sqlLiteral(row[c]))
      return `(${vals.join(", ")})`
    }).join(",\n")
    batches.push(
      `INSERT INTO #syncSrc (${tempCols.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const tempColList = tempCols.map((c) => `[${c}]`).join(", ")
  // Self-join trick: strips IDENTITY property from the temp table.
  const tempCreate = identityCol
    ? `SELECT TOP 0 ${tempCols.map((c) => `a.[${c}]`).join(", ")} INTO #syncSrc FROM ${qtable(tableName)} a LEFT JOIN ${qtable(tableName)} b ON 1 = 0`
    : `SELECT TOP 0 ${tempColList} INTO #syncSrc FROM ${qtable(tableName)}`

  // Build MERGE UPDATE SET — data cols from source + SCD2 meta reset
  const updateParts: string[] = updateCols.map((c) => `T.[${c}] = S.[${c}]`)
  if (hasValidFrom) updateParts.push("T.[validFrom] = GETUTCDATE()")
  if (hasValidTo) updateParts.push("T.[validTo] = NULL")
  const updateSet = updateParts.length > 0
    ? `WHEN MATCHED THEN UPDATE SET ${updateParts.join(", ")}`
    : ""

  // Build MERGE INSERT — data cols + SCD2 meta
  const insertTargetCols = [...tempCols]
  const insertValueExprs = [...tempCols.map((c) => `S.[${c}]`)]
  if (hasValidFrom) { insertTargetCols.push("validFrom"); insertValueExprs.push("GETUTCDATE()") }
  if (hasValidTo)   { insertTargetCols.push("validTo");   insertValueExprs.push("NULL") }
  const insertTarget = insertTargetCols.map((c) => `[${c}]`).join(", ")
  const insertValues = insertValueExprs.join(", ")

  const mergeStmt = [
    identityCol ? `SET IDENTITY_INSERT ${qtable(tableName)} ON` : null,
    `MERGE ${qtable(tableName)} AS T`,
    `USING #syncSrc AS S ON ${pkOn}`,
    updateSet,
    `WHEN NOT MATCHED BY TARGET THEN INSERT (${insertTarget}) VALUES (${insertValues})`,
    `;`,
    identityCol ? `SET IDENTITY_INSERT ${qtable(tableName)} OFF` : null,
  ].filter(Boolean).join("\n")

  const fullSql = [
    tempCreate,
    ...batches,
    mergeStmt,
    `DROP TABLE #syncSrc`,
  ].join(";\n")

  const result = await trackedQuery(
    tx.request(),
    fullSql,
    `applyInsertsUpdates.merge(${tableName})`,
    plan.target,
  )
  // rowsAffected: last meaningful entry is the MERGE itself
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}

/**
 * Apply deletes: rows on target within scope that no longer exist on source.
 * Uses direct source pool — no linked server needed.
 */
async function applyDeletes(tx: Transaction, plan: SyncPlan, tableName: string, pkColumns: string[]): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  const predicate = tableResult.scopePredicate
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot delete.`)

  // 1. Read source PKs.
  const { pool: srcPool } = await getPool(plan.source)
  const pkSelect = pkColumns.map((c) => `[${c}]`).join(", ")
  const srcResult = await trackedQuery(
    srcPool.request(),
    `SELECT ${pkSelect} FROM ${qtable(tableName)} WHERE ${predicate}`,
    `applyDeletes.read(${tableName})`,
    plan.source,
  )
  const srcRows = srcResult.recordset as Record<string, unknown>[]

  // 2. Build full SQL batch: create temp → insert PKs → delete → drop
  const BATCH = 500
  const batches: string[] = []
  for (let i = 0; i < srcRows.length; i += BATCH) {
    const batch = srcRows.slice(i, i + BATCH)
    const valuesList = batch.map((row) => {
      const vals = pkColumns.map((c) => sqlLiteral(row[c]))
      return `(${vals.join(", ")})`
    }).join(",\n")
    batches.push(
      `INSERT INTO #syncSrcPk (${pkColumns.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")
  // Self-join trick strips IDENTITY property so we can INSERT explicit PK values.
  const tempCreate = `SELECT TOP 0 ${pkColumns.map((c) => `a.[${c}]`).join(", ")} INTO #syncSrcPk FROM ${qtable(tableName)} a LEFT JOIN ${qtable(tableName)} b ON 1 = 0`
  // Use CTE to scope the DELETE to rows matching the predicate — avoids fragile
  // regex column-aliasing that breaks on subquery predicates.
  const fullSql = [
    tempCreate,
    ...batches,
    `;WITH Scoped AS (SELECT ${pkSelect} FROM ${qtable(tableName)} WHERE ${predicate})
     DELETE T FROM Scoped T
     LEFT JOIN #syncSrcPk S ON ${pkOn}
     WHERE S.[${pkColumns[0]}] IS NULL`,
    `DROP TABLE #syncSrcPk`,
  ].join(";\n")

  const result = await trackedQuery(
    tx.request(),
    fullSql,
    `applyDeletes.exec(${tableName})`,
    plan.target,
  )
  // The DELETE is the second-to-last statement (before DROP)
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}

/** Convert a JS value to a SQL literal for use in a VALUES clause. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "1" : "0"
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}`
  return `N'${String(v).replace(/'/g, "''")}'`
}
