/**
 * `executeSync` — top-level orchestration of a saved SyncPlan.
 *
 * Wires together the in-tx metadata sync
 * (`runMetadataSync`), and the post-metadata action dispatcher
 * (`runPostMetadataPipeline`). Owns: pre-flight safety rails, run-sink
 * lifecycle, explicit SQL telemetry attribution, and the
 * outer try/catch that translates throws into `sync.execute.failed`
 * events and unlocks the entity.
 *
 * @module
 */

import { flowCatalogFromSnapshot } from "../../../domain/flow-catalog.js"
import { detectCatalogDrift } from "../../../domain/catalog-drift.js"
import { assertSupportedSyncDirection, getEnvironment } from "../../../domain/environments.js"
import { evaluateFreezeWindows } from "../../../domain/governance/freeze-windows.js"
import {
  EventType,
  getPool,
  SyncOperationType,
  SyncProgressKind,
  SyncRunStatus
} from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { loadPlan, planTooOldToExecute, type SyncPlan } from "../plan-store.js"
import { getSyncRunSink } from "../run-sink.js"
import { fetchPkColumns } from "./apply.js"
import { probeTriggers } from "./archive.js"
import { scheduleFlowSteps } from "./flow-scheduler.js"
import { runMetadataSync } from "./metadata-sync.js"
import { constraintRelaxationTables, dataMovementTables } from "./metadata-scope.js"
import { validatePlan } from "./plan-table.js"
import {
  evaluateRootParentPreflight,
  formatRootParentExecuteRefusal
} from "./root-parent-preflight.js"
import { runPostMetadataPipeline } from "./post-metadata-pipeline.js"
import { toSyncExecuteError, throwIfAborted, isAuditGateSkippedError, type ExecuteOptions, type ExecuteProgress } from "./types.js"
export type { ExecuteOptions, ExecuteProgress } from "./types.js"

export async function executeSync(
  planId: string,
  opts: ExecuteOptions
): Promise<{ planId: string; success: boolean; skipped?: boolean; message?: string; error?: string }> {
  if (!opts.confirm) throw new Error("executeSync requires explicit confirm=true.")
  const onProgress = opts.onProgress ?? (() => {})
  const signal = opts.signal

  throwIfAborted(signal)
  onProgress({ type: SyncProgressKind.Started, message: `Loading plan ${planId.slice(0, 8)}…` })

  const plan = loadPlan(opts.host, planId)
  if (!plan) throw new Error(`Plan ${planId} not found or expired.`)
  if (planTooOldToExecute(plan))
    throw new Error(`Plan ${planId} is older than 1 hour — re-preview before executing.`)

  throwIfAborted(signal)
  onProgress({ type: SyncProgressKind.Step, step: "preflight", message: "Validating environments and permissions…" })

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

  if (!plan.executionContract) {
    throw new Error(`Plan ${planId} predates the unified execution contract — re-preview before executing.`)
  }

  const telemetryContext: SyncTelemetryContext = {
    kind: SyncOperationType.Execute,
    opId: planId,
    planId,
    source: plan.source,
    target: plan.target
  }

  throwIfAborted(signal)
  onProgress({
    type: SyncProgressKind.Step,
    step: "catalog-drift",
    message: `Checking catalog compatibility (${plan.source} → ${plan.target})…`
  })

  // Hard refusal on catalog drift (preview surfaces it as warning; execute treats it as fatal).
  // Allowed schemas are now snapshotted into the compiled execution contract.
  const allowedSchemas = plan.executionContract.allowedSchemas
  const drift = await detectCatalogDrift(
    opts.host,
    plan.source,
    plan.target,
    plan.executionContract.metadata.tables.map((t) => t.name),
    allowedSchemas,
    telemetryContext
  )
  throwIfAborted(signal)
  if (!drift.catalogCompatible) {
    throw new Error(
      `Catalog drift detected — refusing to execute. ${drift.issues.length} issue(s):\n` +
        drift.issues
          .slice(0, 10)
          .map((i) => `  • ${i}`)
          .join("\n") +
        (drift.issues.length > 10 ? `\n  … and ${drift.issues.length - 10} more` : "")
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
          `Pass overrideFreezeWindow=true to bypass (audited).`
      )
    }
    if (ev.unknownIds.length > 0) {
      console.warn(
        `[sync.govern] definition references freeze windows with no registered definition: ${ev.unknownIds.join(", ")}`
      )
    }
  }

  // Hard refusal on scope-misattribution conflicts. Inserting a row whose PK
  // already exists on target (under a different parent) would PK-violate and
  // roll back the whole transaction. Refusing here gives the operator an
  // actionable error pointing at the offending rows.
  throwIfAborted(signal)
  onProgress({ type: SyncProgressKind.Step, step: "scope-check", message: "Checking scope conflicts…" })
  const conflictedTables = plan.tables.filter((t) => t.conflicts.length > 0)
  if (conflictedTables.length > 0) {
    const total = conflictedTables.reduce((a, t) => a + t.conflicts.length, 0)
    const sampleLines = conflictedTables
      .flatMap((t) => t.conflicts.slice(0, 3).map((c) => `  • ${t.table}: ${c.summary}`))
      .slice(0, 10)
    throw new Error(
      `Scope misattribution — refusing to execute. ${total} row(s) across ` +
        `${conflictedTables.length} table(s) exist on target under a different parent than source expects:\n` +
        sampleLines.join("\n") +
        `\nFix the target metadata (re-attach these rows to the correct parent) and re-preview.`
    )
  }

  throwIfAborted(signal)
  onProgress({
    type: SyncProgressKind.Step,
    step: "root-parent-check",
    message: "Checking root parent on target…"
  })
  const rootParent = await evaluateRootParentPreflight(opts.host, plan.target, plan)
  throwIfAborted(signal)
  if (!rootParent.ready) {
    throw new Error(formatRootParentExecuteRefusal(rootParent.issue ?? "Root parent is not ready."))
  }

  throwIfAborted(signal)
  onProgress({ type: SyncProgressKind.Step, step: "plan-validation", message: "Validating plan changeSets…" })
  validatePlan(plan)

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
      previewTotals: plan.totals
    })
  } catch (e) {
    console.warn(`[sync.execute] sink.start failed:`, e)
  }

  const execT0 = Date.now()
  onProgress({ type: SyncProgressKind.Started, message: `Executing plan ${planId} → ${plan.target}` })
  emit(opts.host, EventType.SyncExecuteStarted, {
    planId,
    source: plan.source,
    target: plan.target,
    actor: opts.userUpn ?? null,
    definitionId: plan.executionContract.definitionId,
    definitionPublishedVersion: plan.executionContract.definitionPublishedVersion,
    decisionLogCount: plan.decisionLog?.length ?? 0,
    governanceDecision: plan.governanceDecision ?? null,
    totals: plan.totals
  })

  return executeSyncInner(plan, planId, opts, onProgress, execT0, telemetryContext, signal)
}

async function executeSyncInner(
  plan: SyncPlan,
  planId: string,
  opts: ExecuteOptions,
  onProgress: (p: ExecuteProgress) => void,
  execT0: number,
  telemetryContext: SyncTelemetryContext,
  signal?: AbortSignal
): Promise<{ planId: string; success: boolean; skipped?: boolean; message?: string; error?: string }> {
  const executionContract = plan.executionContract
  if (!executionContract) {
    throw new Error(`Plan ${planId} predates the unified execution contract — re-preview before executing.`)
  }

  // Load PK columns once
  throwIfAborted(signal)
  onProgress({ type: SyncProgressKind.Step, step: "pk-discovery", message: "Loading primary keys…" })
  const pkByTable = await fetchPkColumns(
    opts.host,
    plan.source,
    executionContract.metadata.tables.map((t) => t.name),
    telemetryContext
  )
  throwIfAborted(signal)

  const { pool: tgtPool } = await getPool(opts.host, plan.target)
  const { pool: srcPool } = await getPool(opts.host, plan.source)
  if (!tgtPool) throw new Error(`Target pool unavailable.`)
  if (!srcPool) throw new Error(`Source pool unavailable.`)

  const entityId = plan.entity.id
  const entityType = executionContract.definitionId
  const flowSteps = executionContract.flow.steps
  if (!executionContract.flow.catalog) {
    throw new Error(`Plan ${planId} predates the flow catalog snapshot — re-preview before executing.`)
  }
  const flowCatalog = flowCatalogFromSnapshot(executionContract.flow.catalog)
  const scheduled = scheduleFlowSteps(flowSteps)
  const lockStepPresent = flowSteps.some((step) => step.kind === "target-lock")
  const stepWarnings: { step: string; sproc: string; error: string }[] = []

  async function ensureContractUnlockedOnSource(): Promise<void> {
    if (entityType !== "contract" || !lockStepPresent) return
    try {
      await setContractLockOnSource(
        opts.host,
        srcPool,
        plan.source,
        Number(entityId),
        false,
        undefined,
        telemetryContext
      )
    } catch (unlockError) {
      console.warn(`[sync.execute] contract unlock on source (${plan.source}) failed:`, unlockError)
    }
  }

  // Helper: emit a step progress event
  const stepEmit = (name: string, message?: string) => {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(opts.host, EventType.SyncExecuteStep, { planId, step: name })
  }

  try {
    let metadataApplied = { insert: 0, update: 0, delete: 0 }

    if (scheduled.beforeMetadata.length > 0) {
      const { stepWarnings: preWarnings } = await runPostMetadataPipeline({
        host: opts.host,
        tgtPool,
        srcPool,
        plan,
        planId,
        entityId,
        entityType,
        onProgress,
        telemetryContext,
        userUpn: opts.userUpn,
        steps: scheduled.beforeMetadata,
        flowCatalog,
        asDeploySteps: false,
      })
      stepWarnings.push(...preWarnings)
    }

    const metadataStep = scheduled.metadata
    const movementTables = dataMovementTables(plan)
    const triggerCache = await probeTriggers(
      opts.host,
      tgtPool,
      planId,
      plan.target,
      [...movementTables],
      telemetryContext
    )
    stepEmit(metadataStep.id, metadataStep.description)
    const { applied } = await runMetadataSync({
      host: opts.host,
      plan,
      planId,
      pkByTable,
      triggerCache,
      onProgress,
      target: plan.target,
      tgtPool,
      telemetryContext,
    })
    metadataApplied = applied
    stepEmit(`${metadataStep.id}-done`, "Metadata sync committed")

    if (scheduled.afterMetadata.length > 0) {
      const { stepWarnings: pipelineWarnings } = await runPostMetadataPipeline({
        host: opts.host,
        tgtPool,
        srcPool,
        plan,
        planId,
        entityId,
        entityType,
        onProgress,
        telemetryContext,
        userUpn: opts.userUpn,
        steps: scheduled.afterMetadata,
        flowCatalog,
        asDeploySteps: true,
      })
      stepWarnings.push(...pipelineWarnings)
    }

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
    if (hasStepFailures) {
      onProgress({
        type: SyncProgressKind.Failed,
        step: "deploy",
        error: stepErrorSummary,
        message: completedMsg,
      })
    } else {
      onProgress({ type: SyncProgressKind.Completed, message: completedMsg })
    }
    emit(opts.host, EventType.SyncExecuteCompleted, {
      planId,
      definitionId: executionContract.definitionId,
      definitionPublishedVersion: executionContract.definitionPublishedVersion,
      durationMs: Date.now() - execT0,
      applied: metadataApplied,
      warnings: stepWarnings
    })
    try {
      getSyncRunSink(opts.host).finish({
        planId,
        // Any step failure = failed run. Data may have been applied but the
        // pipeline didn't complete cleanly — never show this as success.
        status: hasStepFailures ? SyncRunStatus.Failed : SyncRunStatus.Success,
        error: stepErrorSummary,
        executeTotals: metadataApplied,
        durationMs: Date.now() - execT0
      })
    } catch (e) {
      console.warn(`[sync.execute] sink.finish failed:`, e)
    }
    return { planId, success: !hasStepFailures, error: stepErrorSummary }
  } catch (e) {
    if (isAuditGateSkippedError(e)) {
      const skipMsg = e.message
      onProgress({ type: SyncProgressKind.Step, step: e.step, message: skipMsg })
      onProgress({ type: SyncProgressKind.Skipped, step: e.step, message: skipMsg })
      emit(opts.host, EventType.SyncExecuteSkipped, {
        planId,
        definitionId: executionContract.definitionId,
        definitionPublishedVersion: executionContract.definitionPublishedVersion,
        step: e.step,
        message: skipMsg,
        durationMs: Date.now() - execT0
      })
      try {
        getSyncRunSink(opts.host).finish({
          planId,
          status: SyncRunStatus.Skipped,
          error: skipMsg,
          executeTotals: { insert: 0, update: 0, delete: 0 },
          durationMs: Date.now() - execT0
        })
      } catch (finishError) {
        console.warn(`[sync.execute] sink.finish failed:`, finishError)
      }
      return { planId, success: true, skipped: true, message: skipMsg }
    }

    const failure = toSyncExecuteError(e, { step: "execute" })
    const cancelled = Boolean(signal?.aborted)
    const msg = cancelled ? "Cancelled by user" : failure.message
    if (cancelled) {
      console.warn(`[sync.execute] plan ${planId} cancelled`)
    } else {
      console.error(`[sync.execute] plan ${planId} failed:`, e)
    }
    onProgress({
      type: SyncProgressKind.Failed,
      step: failure.step,
      table: failure.table,
      error: msg,
      message: cancelled ? msg : failure.causeDetail
    })
    if (cancelled) {
      emit(opts.host, EventType.SyncExecuteCancelled, {
        planId,
        definitionId: executionContract.definitionId,
        definitionPublishedVersion: executionContract.definitionPublishedVersion,
        durationMs: Date.now() - execT0
      })
    } else {
      emit(opts.host, EventType.SyncExecuteFailed, {
        planId,
        definitionId: executionContract.definitionId,
        definitionPublishedVersion: executionContract.definitionPublishedVersion,
        error: msg,
        step: failure.step,
        table: failure.table ?? null,
        op: failure.op ?? null,
        cause: failure.causeDetail ?? null,
        durationMs: Date.now() - execT0
      })
    }
    try {
      getSyncRunSink(opts.host).finish({
        planId,
        status: cancelled ? SyncRunStatus.Cancelled : SyncRunStatus.Failed,
        error: msg,
        durationMs: Date.now() - execT0
      })
    } catch {
      /* ignore */
    }
    return { planId, success: false, error: msg }
  } finally {
    await ensureContractUnlockedOnSource()
  }
}
