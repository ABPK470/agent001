/**
 * `executeSync` — top-level orchestration of a saved SyncPlan.
 *
 * Wires together drift re-validation, the in-tx metadata sync
 * (`runMetadataSync`), and the post-tx contract pipeline
 * (`runContractPipeline`). Owns: pre-flight safety rails, run-sink
 * lifecycle, explicit SQL telemetry attribution, and the
 * outer try/catch that translates throws into `sync.execute.failed`
 * events and unlocks the entity.
 *
 * @module
 */

import { detectCatalogDrift } from "../catalog-drift.js"
import { EventType, getPool, SyncOperationType, SyncProgressKind, SyncRunStatus } from "../contracts.js"
import { getEnvironment } from "../environments.js"
import { evaluateFreezeWindows } from "../governance/freeze-windows.js"
import { loadPlan, planTooOldToExecute, type SyncPlan } from "../plan-store.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../sync-events.js"
import { getSyncRunSink } from "../sync-run-sink.js"
import { fetchPkColumns } from "./apply.js"
import { probeTriggers } from "./archive.js"
import { runAuditCheckDirect, setContractLockDirect } from "./contract-deploy.js"
import { DRIFT_ABORT_PCT } from "./db-helpers.js"
import { revalidatePlanDrift } from "./drift.js"
import { runContractPipeline } from "./execute-pipeline.js"
import { runMetadataSync } from "./metadata-sync.js"
import type { ExecuteOptions, ExecuteProgress } from "./types.js"
export type { ExecuteOptions, ExecuteProgress } from "./types.js"

export async function executeSync(planId: string, opts: ExecuteOptions): Promise<{ planId: string; success: boolean; error?: string }> {
  if (!opts.confirm) throw new Error("executeSync requires explicit confirm=true.")
  const plan = loadPlan(opts.host, planId)
  if (!plan) throw new Error(`Plan ${planId} not found or expired.`)
  if (planTooOldToExecute(plan)) throw new Error(`Plan ${planId} is older than 1 hour — re-preview before executing.`)

  // Safety: target writeEnabled
  const targetEnv = getEnvironment(opts.host, plan.target)
  if (targetEnv.role === "source") throw new Error(`Target "${targetEnv.name}" is source-only.`)
  // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
  if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
    throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
  }
  if (targetEnv.syncAllowlist.length && (!opts.userUpn || !targetEnv.syncAllowlist.includes(opts.userUpn))) {
    throw new Error(`User ${opts.userUpn ?? "<anonymous>"} is not in sync allowlist for "${targetEnv.name}".`)
  }

  // Hard refusal on catalog drift (preview surfaces it as warning; execute treats it as fatal).
  // Allowed-schemas set is derived from the recipe snapshot so we don't depend
  // on the legacy Mymi-only hardcoded allowlist.
  const allowedSchemas = Array.from(new Set(plan.recipeSnapshot.tables.map((t) => {
    const ix = t.name.indexOf(".")
    return ix > 0 ? t.name.slice(0, ix) : ""
  }).filter((s) => s.length > 0)))
  const drift = await detectCatalogDrift(
    opts.host,
    plan.source,
    plan.target,
    plan.recipeSnapshot.tables.map((t) => t.name),
    allowedSchemas,
  )
  if (!drift.catalogCompatible) {
    throw new Error(
      `Catalog drift detected — refusing to execute. ${drift.issues.length} issue(s):\n` +
      drift.issues.slice(0, 10).map((i) => `  • ${i}`).join("\n") +
      (drift.issues.length > 10 ? `\n  … and ${drift.issues.length - 10} more` : ""),
    )
  }

  // Governance: evaluate entity-registry freeze windows. Soft block — the
  // operator can override (audited) via opts.overrideFreezeWindow. When
  // no windows are configured this is a no-op.
  if (plan.entityPolicies && plan.entityPolicies.freezeWindowIds.length > 0) {
    const ev = evaluateFreezeWindows(plan.entityPolicies.freezeWindowIds)
    if (ev.active && !opts.overrideFreezeWindow) {
      const names = ev.activeWindows.map((w) => `${w.id} (${w.displayName})`).join(", ")
      throw new Error(
        `Sync blocked by active freeze window(s): ${names}. ` +
        `Pass overrideFreezeWindow=true to bypass (audited).`,
      )
    }
    if (ev.unknownIds.length > 0) {
      console.warn(`[sync.govern] entity references freeze windows with no registered definition: ${ev.unknownIds.join(", ")}`)
    }
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
    getSyncRunSink(opts.host).start({
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
  onProgress({ type: SyncProgressKind.Started, message: `Executing plan ${planId} → ${plan.target}` })
  emit(opts.host, EventType.SyncExecuteStarted, {
    planId, source: plan.source, target: plan.target,
    actor: opts.userUpn ?? null,
    totals: plan.totals,
  })

  const telemetryContext: SyncTelemetryContext = {
    kind: SyncOperationType.Execute,
    opId: planId,
    source: plan.source,
    target: plan.target,
  }
  return executeSyncInner(plan, planId, opts, onProgress, execT0, telemetryContext)
}

async function executeSyncInner(
  plan: SyncPlan,
  planId: string,
  opts: ExecuteOptions,
  onProgress: (p: ExecuteProgress) => void,
  execT0: number,
  telemetryContext: SyncTelemetryContext,
): Promise<{ planId: string; success: boolean; error?: string }> {
  // Load PK columns once
  const pkByTable = await fetchPkColumns(opts.host, plan.source, plan.recipeSnapshot.tables.map((t) => t.name), telemetryContext)

  // Drift re-validation
  const driftPct = await revalidatePlanDrift(opts.host, plan)
  if (driftPct !== null && driftPct > DRIFT_ABORT_PCT) {
    const msg = `Plan drift ${(driftPct * 100).toFixed(1)}% exceeds ${(DRIFT_ABORT_PCT * 100).toFixed(0)}% threshold — re-preview before executing.`
    onProgress({ type: SyncProgressKind.Failed, error: msg })
    emit(opts.host, EventType.SyncExecuteFailed, { planId, error: msg, durationMs: Date.now() - execT0, driftPct })
    try { getSyncRunSink(opts.host).finish({ planId, status: SyncRunStatus.Failed, error: msg, driftDetectedPct: driftPct, durationMs: Date.now() - execT0 }) } catch { /* ignore */ }
    return { planId, success: false, error: msg }
  }
  void opts

  const { pool: tgtPool } = await getPool(opts.host, plan.target)
  const { pool: srcPool } = await getPool(opts.host, plan.source)
  if (!tgtPool) throw new Error(`Target pool unavailable.`)

  const entityId = plan.entity.id
  const entityType = plan.recipeSnapshot.entityType
  const isContract = entityType === "contract"

  const stepWarnings: { step: string; sproc: string; error: string }[] = []

  // Helper: emit a step progress event
  const stepEmit = (name: string, message?: string) => {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(opts.host, EventType.SyncExecuteStep, { planId, step: name })
  }

  // Pre-tx contract setup helper (audit-check / lock).
  // These sprocs run before tx.begin() so a sproc-level failure
  // doesn't poison the metadata-sync transaction.
  async function preTxContractStep(stepName: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} failed:`, e)
      stepWarnings.push({ step: stepName, sproc: "direct", error: errMsg })
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: `${stepName} failed`, error: errMsg })
      emit(opts.host, EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: "direct", error: errMsg })
    }
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // Pipeline lifecycle — mirrors pipeline 788 activity sequence
    // ═══════════════════════════════════════════════════════════

    // ── Step 1: Audit pre-check ──
    stepEmit("audit-check", "Pre-sync audit check")
    await preTxContractStep("audit-check", async () => {
      await runAuditCheckDirect(opts.host, tgtPool, {
        action: "syncOrNot",
        objType: entityType === "contract" ? "Contract" : entityType,
        id: entityId,
      }, plan.target, undefined, telemetryContext)
    })

    // ── Step 2: Lock entity for sync ──
    stepEmit("lock", `Locking ${entityType}`)
    if (isContract) {
      await preTxContractStep("lock", async () => {
        await setContractLockDirect(opts.host, tgtPool, Number(entityId), true, plan.target, undefined, telemetryContext)
      })
    }

    // Pre-flight: batch-probe target triggers BEFORE tx.begin() so the
    // per-table maybeArchive() probe doesn't block on Sch-S waits while
    // the tx holds Sch-M locks (~60s lock_timeout × N tables).
    const upsertTables = plan.recipeSnapshot.executionOrder.filter((tn) => {
      const tr = plan.tables.find((t) => t.table === tn)
      return tr && tr.counts.insert + tr.counts.update > 0
    })
    const triggerCache = await probeTriggers(opts.host, tgtPool, planId, plan.target, upsertTables, telemetryContext)

    // ── Step 4: Sync metadata in transaction ──
    stepEmit("sync-metadata", "Syncing metadata rows")
    const { applied: appliedTotals } = await runMetadataSync({
      host: opts.host, plan, planId, pkByTable, triggerCache, onProgress, target: plan.target, tgtPool, telemetryContext,
    })
    stepEmit("sync-metadata-done", "Metadata sync committed")

    // ── Steps 5-23: Post-tx contract pipeline ──
    const { stepWarnings: pipelineWarnings } = await runContractPipeline({
      host: opts.host, tgtPool, srcPool, plan, planId, isContract,
      entityId, entityType, onProgress, telemetryContext,
    })
    stepWarnings.push(...pipelineWarnings)

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
    onProgress({ type: SyncProgressKind.Completed, message: completedMsg })
    emit(opts.host, EventType.SyncExecuteCompleted, { planId, durationMs: Date.now() - execT0, applied: appliedTotals, warnings: stepWarnings })
    try {
      getSyncRunSink(opts.host).finish({
        planId,
        // Any step failure = failed run. Data may have been applied but the
        // pipeline didn't complete cleanly — never show this as success.
        status: hasStepFailures ? SyncRunStatus.Failed : SyncRunStatus.Success,
        error: stepErrorSummary,
        executeTotals: appliedTotals,
        driftDetectedPct: driftPct,
        durationMs: Date.now() - execT0,
      })
    } catch (e) { console.warn(`[sync.execute] sink.finish failed:`, e) }
    return { planId, success: !hasStepFailures, error: stepErrorSummary }
  } catch (e) {
    // Unlock the entity on failure to avoid leaving it locked. The metadata-sync
    // helper already rolled back the tx and re-enabled FKs on failure.
    if (isContract) {
      try { await setContractLockDirect(opts.host, tgtPool, Number(entityId), false, plan.target, undefined, telemetryContext) }
      catch { /* best-effort */ }
    }

    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[sync.execute] plan ${planId} failed:`, e)
    onProgress({ type: SyncProgressKind.Failed, error: msg })
    emit(opts.host, EventType.SyncExecuteFailed, { planId, error: msg, durationMs: Date.now() - execT0 })
    try { getSyncRunSink(opts.host).finish({ planId, status: SyncRunStatus.Failed, error: msg, driftDetectedPct: driftPct, durationMs: Date.now() - execT0 }) }
    catch { /* ignore */ }
    return { planId, success: false, error: msg }
  }
}
