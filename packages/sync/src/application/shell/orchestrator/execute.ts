/**
 * `executeSync` — top-level orchestration of a saved SyncPlan.
 *
 * Wires together drift re-validation, the in-tx metadata sync
 * (`runMetadataSync`), and the post-metadata action dispatcher
 * (`runPostMetadataPipeline`). Owns: pre-flight safety rails, run-sink
 * lifecycle, explicit SQL telemetry attribution, and the
 * outer try/catch that translates throws into `sync.execute.failed`
 * events and unlocks the entity.
 *
 * @module
 */

import { detectCatalogDrift } from "../../../domain/catalog-drift.js"
import { assertSupportedSyncDirection, getEnvironment } from "../../../domain/environments.js"
import { evaluateFreezeWindows } from "../../../domain/governance/freeze-windows.js"
import { EventType, getPool, SyncOperationType, SyncProgressKind, SyncRunStatus } from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { loadPlan, planTooOldToExecute, type SyncPlan } from "../plan-store.js"
import { getSyncRunSink } from "../run-sink.js"
import { fetchPkColumns } from "./apply.js"
import { probeTriggers } from "./archive.js"
import { runAuditCheckDirect, setContractLockDirect } from "./contract-deploy.js"
import { DRIFT_ABORT_PCT } from "./db-helpers.js"
import { revalidatePlanDrift } from "./drift.js"
import { runMetadataSync } from "./metadata-sync.js"
import { runPostMetadataPipeline } from "./post-metadata-pipeline.js"
import { toSyncExecuteError, type ExecuteOptions, type ExecuteProgress } from "./types.js"
export type { ExecuteOptions, ExecuteProgress } from "./types.js"

function requireAuditObjectType(step: { id: string; auditObjectType?: string | null }): string {
  if (typeof step.auditObjectType === "string" && step.auditObjectType.trim().length > 0) return step.auditObjectType
  throw new Error(`Execution contract step ${step.id} is missing auditObjectType.`)
}

export async function executeSync(planId: string, opts: ExecuteOptions): Promise<{ planId: string; success: boolean; error?: string }> {
  if (!opts.confirm) throw new Error("executeSync requires explicit confirm=true.")
  const plan = loadPlan(opts.host, planId)
  if (!plan) throw new Error(`Plan ${planId} not found or expired.`)
  if (planTooOldToExecute(plan)) throw new Error(`Plan ${planId} is older than 1 hour — re-preview before executing.`)

  // Safety: target writeEnabled
  const sourceEnv = getEnvironment(opts.host, plan.source)
  const targetEnv = getEnvironment(opts.host, plan.target)
  if (sourceEnv.role === "target") throw new Error(`Source "${sourceEnv.name}" is target-only.`)
  if (targetEnv.role === "source") throw new Error(`Target "${targetEnv.name}" is source-only.`)
  assertSupportedSyncDirection(sourceEnv, targetEnv)
  // Hard block: PROD is read-only until explicitly unlocked by ops (SYNC_ALLOW_PROD=1).
  if (targetEnv.name.toLowerCase() === "prod" && !process.env["SYNC_ALLOW_PROD"]) {
    throw new Error(`Sync to PROD is currently disabled. Set SYNC_ALLOW_PROD=1 to unlock.`)
  }
  if (targetEnv.syncAllowlist.length && (!opts.userUpn || !targetEnv.syncAllowlist.includes(opts.userUpn))) {
    throw new Error(`User ${opts.userUpn ?? "<anonymous>"} is not in sync allowlist for "${targetEnv.name}".`)
  }

  if (!plan.executionContract) {
    throw new Error(`Plan ${planId} predates the unified execution contract — re-preview before executing.`)
  }

  // Hard refusal on catalog drift (preview surfaces it as warning; execute treats it as fatal).
  // Allowed schemas are now snapshotted into the compiled execution contract.
  const allowedSchemas = plan.executionContract.allowedSchemas
  const drift = await detectCatalogDrift(
    opts.host,
    plan.source,
    plan.target,
    plan.executionContract.metadata.tables.map((t) => t.name),
    allowedSchemas,
  )
  if (!drift.catalogCompatible) {
    throw new Error(
      `Catalog drift detected — refusing to execute. ${drift.issues.length} issue(s):\n` +
      drift.issues.slice(0, 10).map((i) => `  • ${i}`).join("\n") +
      (drift.issues.length > 10 ? `\n  … and ${drift.issues.length - 10} more` : ""),
    )
  }

  // Governance: evaluate the snapshotted definition governance against the
  // current freeze-window registry. Soft block — the operator can override
  // (audited) via opts.overrideFreezeWindow. When no windows are configured
  // this is a no-op.
  if (plan.executionContract.governance.freezeWindowIds.length > 0) {
    const ev = evaluateFreezeWindows(plan.executionContract.governance.freezeWindowIds)
    if (ev.active && !opts.overrideFreezeWindow) {
      const names = ev.activeWindows.map((w) => `${w.id} (${w.displayName})`).join(", ")
      throw new Error(
        `Sync blocked by active freeze window(s): ${names}. ` +
        `Pass overrideFreezeWindow=true to bypass (audited).`,
      )
    }
    if (ev.unknownIds.length > 0) {
      console.warn(`[sync.govern] definition references freeze windows with no registered definition: ${ev.unknownIds.join(", ")}`)
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
    definitionId: plan.executionContract.definitionId,
    definitionPublishedVersion: plan.executionContract.definitionPublishedVersion,
    decisionLogCount: plan.decisionLog?.length ?? 0,
    governanceDecision: plan.governanceDecision ?? null,
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
  const executionContract = plan.executionContract
  if (!executionContract) {
    throw new Error(`Plan ${planId} predates the unified execution contract — re-preview before executing.`)
  }

  // Load PK columns once
  const pkByTable = await fetchPkColumns(opts.host, plan.source, executionContract.metadata.tables.map((t) => t.name), telemetryContext)

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
  const entityType = executionContract.definitionId
  const flowSteps = executionContract.flow.steps
  const lockStepPresent = flowSteps.some((step) => step.kind === "targetLock")
  const stepWarnings: { step: string; sproc: string; error: string }[] = []

  // Helper: emit a step progress event
  const stepEmit = (name: string, message?: string) => {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(opts.host, EventType.SyncExecuteStep, { planId, step: name })
  }

  // Pre-tx contract setup helper (audit-check / lock).
  // These sprocs run before tx.begin() so a sproc-level failure
  // doesn't poison the metadata-sync transaction.
  async function preTxStep(stepName: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} failed:`, e)
      stepWarnings.push({ step: stepName, sproc: "direct", error: errMsg })
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: `${stepName} failed`, error: errMsg })
      emit(opts.host, EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: "direct", error: errMsg })
      return false
    }
  }

  try {
    const postMetadataSteps = []
    let metadataApplied = { insert: 0, update: 0, delete: 0 }
    let metadataStepSeen = false

    for (const stepDef of flowSteps) {
      if (metadataStepSeen) {
        postMetadataSteps.push(stepDef)
        continue
      }

      switch (stepDef.kind) {
        case "auditCheck": {
          stepEmit(stepDef.id, stepDef.description)
          await preTxStep(stepDef.id, async () => {
            await runAuditCheckDirect(opts.host, tgtPool, {
              action: "syncOrNot",
              objType: requireAuditObjectType(stepDef),
              id: entityId,
            }, plan.target, undefined, telemetryContext)
          })
          break
        }
        case "targetLock": {
          stepEmit(stepDef.id, stepDef.description)
          await preTxStep(stepDef.id, async () => {
            await setContractLockDirect(opts.host, tgtPool, Number(entityId), true, plan.target, undefined, telemetryContext)
          })
          break
        }
        case "metadataSync": {
          const upsertTables = executionContract.metadata.executionOrder.filter((tn) => {
            const tr = plan.tables.find((t) => t.table === tn)
            return tr && tr.counts.insert + tr.counts.update > 0
          })
          const triggerCache = await probeTriggers(opts.host, tgtPool, planId, plan.target, upsertTables, telemetryContext)
          stepEmit(stepDef.id, stepDef.description)
          const { applied } = await runMetadataSync({
            host: opts.host, plan, planId, pkByTable, triggerCache, onProgress, target: plan.target, tgtPool, telemetryContext,
          })
          metadataApplied = applied
          metadataStepSeen = true
          stepEmit(`${stepDef.id}-done`, "Metadata sync committed")
          break
        }
        default:
          postMetadataSteps.push(stepDef)
          break
      }
    }

    const { stepWarnings: pipelineWarnings } = await runPostMetadataPipeline({
      host: opts.host, tgtPool, srcPool, plan, planId,
      entityId, entityType, onProgress, telemetryContext,
      userUpn: opts.userUpn,
      steps: postMetadataSteps,
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
    emit(opts.host, EventType.SyncExecuteCompleted, {
      planId,
      definitionId: executionContract.definitionId,
      definitionPublishedVersion: executionContract.definitionPublishedVersion,
      durationMs: Date.now() - execT0,
      applied: metadataApplied,
      warnings: stepWarnings,
    })
    try {
      getSyncRunSink(opts.host).finish({
        planId,
        // Any step failure = failed run. Data may have been applied but the
        // pipeline didn't complete cleanly — never show this as success.
        status: hasStepFailures ? SyncRunStatus.Failed : SyncRunStatus.Success,
        error: stepErrorSummary,
        executeTotals: metadataApplied,
        driftDetectedPct: driftPct,
        durationMs: Date.now() - execT0,
      })
    } catch (e) { console.warn(`[sync.execute] sink.finish failed:`, e) }
    return { planId, success: !hasStepFailures, error: stepErrorSummary }
  } catch (e) {
    // Unlock the entity on failure to avoid leaving it locked. The metadata-sync
    // helper already rolled back the tx and re-enabled FKs on failure.
    if (lockStepPresent) {
      try { await setContractLockDirect(opts.host, tgtPool, Number(entityId), false, plan.target, undefined, telemetryContext) }
      catch { /* best-effort */ }
    }

    const failure = toSyncExecuteError(e, { step: "execute" })
    const msg = failure.message
    console.error(`[sync.execute] plan ${planId} failed:`, e)
    onProgress({ type: SyncProgressKind.Failed, step: failure.step, table: failure.table, error: msg, message: failure.causeDetail })
    emit(opts.host, EventType.SyncExecuteFailed, {
      planId,
      definitionId: executionContract.definitionId,
      definitionPublishedVersion: executionContract.definitionPublishedVersion,
      error: msg,
      step: failure.step,
      table: failure.table ?? null,
      op: failure.op ?? null,
      cause: failure.causeDetail ?? null,
      durationMs: Date.now() - execT0,
    })
    try { getSyncRunSink(opts.host).finish({ planId, status: SyncRunStatus.Failed, error: msg, driftDetectedPct: driftPct, durationMs: Date.now() - execT0 }) }
    catch { /* ignore */ }
    return { planId, success: false, error: msg }
  }
}
