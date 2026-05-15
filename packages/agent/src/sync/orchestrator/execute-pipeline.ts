/**
 * `runContractPipeline` — the post-tx target-side sproc choreography
 * that runs after the metadata sync commits.
 *
 * Mirrors the legacy ABI pipeline 788 activity sequence: audit checks,
 * lock toggling, dataset/FK/ETL deployment, sync-date stamping. Most
 * sproc failures here are non-fatal (logged + accumulated as
 * `stepWarnings`) so a partial deployment is still recorded as a run
 * with explicit errors instead of an opaque rollback.
 *
 * @module
 */

import sqlMod, { type ConnectionPool } from "mssql"
import { EventType } from "../../domain/enums/event.js"
import { SyncProgressKind } from "../../domain/enums/sync.js"
import { type SyncPlan } from "../plan-store.js"
import { emitSyncEvent as emit } from "../sync-events.js"
import { trackedExecute } from "./db-helpers.js"
import type { ExecuteProgress } from "./types.js"

export interface ContractPipelineInput {
  tgtPool: ConnectionPool
  srcPool: ConnectionPool
  plan: SyncPlan
  planId: string
  isContract: boolean
  entityId: string | number
  entityType: string
  linkedService: string
  onProgress: (p: ExecuteProgress) => void
}

export interface StepWarning {
  step: string
  sproc: string
  error: string
}

export async function runContractPipeline(input: ContractPipelineInput): Promise<{ stepWarnings: StepWarning[] }> {
  const { tgtPool, srcPool, planId, isContract, entityId, entityType, linkedService, onProgress } = input
  const stepWarnings: StepWarning[] = []

  // Helper: call a target-side sproc, best-effort. Non-fatal failures log + warn.
  async function callTargetSproc(sprocName: string, params: Record<string, unknown>, stepName: string): Promise<boolean> {
    try {
      const req = tgtPool.request()
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "number") req.input(k, sqlMod.Int, v)
        else if (typeof v === "boolean") req.input(k, sqlMod.Bit, v)
        else req.input(k, sqlMod.NVarChar(4000), v == null ? null : String(v))
      }
      await trackedExecute(req, sprocName, `callTargetSproc(${stepName}/${sprocName})`, input.plan.target)
      return true
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} (${sprocName}) failed:`, e)
      stepWarnings.push({ step: stepName, sproc: sprocName, error: errMsg })
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: `${stepName} (${sprocName}) failed`, error: errMsg })
      emit(EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: sprocName, error: errMsg })
      return false
    }
  }

  // Helper: emit a step progress event
  function step(name: string, message?: string) {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(EventType.SyncExecuteStep, { planId, step: name })
  }

  // ── Step 6: Get pipelineId for contract — contract only ──
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

  // ── Step 7: Register remote pipeline — contract only ──
  if (isContract && pipelineIdForContract != null) {
    step("register-pipeline", "Registering remote pipeline")
    try {
      await callTargetSproc("core.uspSyncRegisterRemotePipeline", {
        pipelineId: pipelineIdForContract, linkedService,
      }, "register-pipeline")
    } catch (e) { console.warn(`[sync.execute] register-pipeline failed:`, e) }
  }

  // ── Step 8: Undeploy contract on target — contract only ──
  if (isContract) {
    step("undeploy", "Undeploying contract on target")
    await callTargetSproc("core.uspSyncUndeployMarkedContract", { contractId: entityId, linkedService }, "undeploy")
  }

  // ── Step 9: Unlock after undeploy ──
  if (isContract) {
    step("unlock-after-undeploy", "Unlocking after undeploy")
    await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: false }, "unlock-after-undeploy")
  }

  // ── Step 10: Second audit check before deploy ──
  if (isContract) {
    step("audit-check-2", "Pre-deploy audit check")
    await callTargetSproc("core.uspAuditRunCheck", {
      action: "syncOrNot", objType: "Contract", id: entityId,
    }, "audit-check-2")
  }

  // ── Step 11: Lock for deployment ──
  if (isContract) {
    step("lock-for-deploy", "Locking for deployment")
    await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: true }, "lock-for-deploy")
  }

  // ── Step 12: Deploy pre-script ──
  if (isContract) {
    step("deploy-pre-script", "Running pre-deployment scripts")
    await callTargetSproc("core.uspSyncRunContractDeploymentScripts", {
      contractId: entityId, action: "Run preScript", linkedService,
    }, "deploy-pre-script")
  }

  // ── Steps 13-17: Create datasets — contract only ──
  if (isContract) {
    for (const dsType of ["stage", "archive", "list", "dim", "fact"] as const) {
      step(`create-dataset-${dsType}`, `Creating ${dsType} dataset`)
      await callTargetSproc("core.uspSyncCreateDatasets", {
        contractId: entityId, type: dsType, linkedService,
      }, `create-dataset-${dsType}`)
    }
  }

  // ── Step 18: Create foreign keys ──
  if (isContract) {
    step("create-fks", "Creating foreign keys")
    await callTargetSproc("core.uspSyncCreateDatasetFKs", {
      linkedService, contractId: entityId,
    }, "create-fks")
  }

  // ── Step 19: Deploy ETL2 custom transformation ──
  if (isContract) {
    step("deploy-etl", "Deploying ETL custom transformations")
    await callTargetSproc("core.uspSyncDeployETL2CustomTransformation", {
      contractId: entityId, linkedService,
    }, "deploy-etl")
  }

  // ── Step 20: Deploy routine ──
  if (isContract) {
    step("deploy-routine", "Deploying routines")
    await callTargetSproc("core.uspSyncDeployRoutine", {
      contractId: entityId, linkedService,
    }, "deploy-routine")
  }

  // ── Step 21: Deploy post-script ──
  if (isContract) {
    step("deploy-post-script", "Running post-deployment scripts")
    await callTargetSproc("core.uspSyncRunContractDeploymentScripts", {
      contractId: entityId, action: "Run postScript", linkedService,
    }, "deploy-post-script")
  }

  // ── Step 22: Unlock after deployment ──
  if (isContract) {
    step("unlock-after-deploy", "Unlocking after deployment")
    await callTargetSproc("core.uspSetContractLock", { contractId: entityId, isLocked: false }, "unlock-after-deploy")
  }

  // ── Step 23: Set sync date at source ──
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
    onProgress({ type: SyncProgressKind.Step, step: "set-sync-date", message: "set-sync-date (core.uspAuditRunCheck) failed", error: errMsg })
    emit(EventType.SyncExecuteStepFailed, { planId, step: "set-sync-date", sproc: "core.uspAuditRunCheck", error: errMsg })
  }

  // ── Step 24: Update deployment date on target ──
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

  return { stepWarnings }
}
