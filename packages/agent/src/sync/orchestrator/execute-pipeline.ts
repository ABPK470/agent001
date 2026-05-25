/**
 * `runContractPipeline` — the post-tx contract deployment sequence
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

import { type ConnectionPool } from "mssql"
import { EventType } from "../../domain/enums/event.js"
import { SyncProgressKind } from "../../domain/enums/sync.js"
import type { AgentHost } from "../../host/index.js"
import { type SyncPlan } from "../plan-store.js"
import { emitSyncEvent as emit } from "../sync-events.js"
import {
    createDataset,
    createDatasetFKs,
    deployETL,
    deployRoutine,
    resolveContractName,
    runAuditCheckDirect,
    runContractDeploymentScriptsDirect,
    setContractLockDirect,
    undeployMarkedContract,
} from "./contract-deploy.js"
import type { ExecuteProgress } from "./types.js"

export interface ContractPipelineInput {
  host: AgentHost
  tgtPool: ConnectionPool
  srcPool: ConnectionPool
  plan: SyncPlan
  planId: string
  isContract: boolean
  entityId: string | number
  entityType: string
  onProgress: (p: ExecuteProgress) => void
}

export interface StepWarning {
  step: string
  sproc: string
  error: string
}

export async function runContractPipeline(input: ContractPipelineInput): Promise<{ stepWarnings: StepWarning[] }> {
  const { tgtPool, srcPool, planId, isContract, entityId, entityType, onProgress } = input
  const host = input.host
  const stepWarnings: StepWarning[] = []

  async function callDirectStep(stepName: string, fn: () => Promise<void>, opName = stepName): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} (${opName}) failed:`, e)
      stepWarnings.push({ step: stepName, sproc: "direct", error: errMsg })
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: `${stepName} (${opName}) failed`, error: errMsg })
      emit(host, EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: "direct", error: errMsg })
      return false
    }
  }

  // Helper: emit a step progress event
  function step(name: string, message?: string) {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(host, EventType.SyncExecuteStep, { planId, step: name })
  }

  // ── Step 8: Undeploy contract on target — contract only ──
  // Resolve contractName once for all subsequent heavy steps.
  let contractName: string | undefined
  if (isContract) {
    contractName = await resolveContractName(host, tgtPool, Number(entityId), input.plan.target)
  }

  if (isContract) {
    step("undeploy", "Undeploying contract on target")
    await callDirectStep("undeploy", async () => {
      await undeployMarkedContract(host, tgtPool, Number(entityId), input.plan.target)
    })
  }

  // ── Step 9: Unlock after undeploy ──
  if (isContract) {
    step("unlock-after-undeploy", "Unlocking after undeploy")
    await callDirectStep("unlock-after-undeploy", async () => {
      await setContractLockDirect(host, tgtPool, Number(entityId), false, input.plan.target)
    })
  }

  // ── Step 10: Second audit check before deploy ──
  if (isContract) {
    step("audit-check-2", "Pre-deploy audit check")
    await callDirectStep("audit-check-2", async () => {
      await runAuditCheckDirect(host, tgtPool, {
        action: "syncOrNot",
        objType: "Contract",
        id: entityId,
      }, input.plan.target)
    })
  }

  // ── Step 11: Lock for deployment ──
  if (isContract) {
    step("lock-for-deploy", "Locking for deployment")
    await callDirectStep("lock-for-deploy", async () => {
      await setContractLockDirect(host, tgtPool, Number(entityId), true, input.plan.target)
    })
  }

  // ── Step 12: Deploy pre-script ──
  if (isContract) {
    step("deploy-pre-script", "Running pre-deployment scripts")
    await callDirectStep("deploy-pre-script", async () => {
      await runContractDeploymentScriptsDirect(host, tgtPool, contractName!, "Run preScript", input.plan.target)
    })
  }

  // ── Steps 13-17: Create datasets — contract only ──
  if (isContract) {
    for (const dsType of ["stage", "archive", "list", "dim", "fact"] as const) {
      step(`create-dataset-${dsType}`, `Creating ${dsType} dataset`)
      await callDirectStep(`create-dataset-${dsType}`, async () => {
        await createDataset(host, tgtPool, Number(entityId), contractName!, dsType, input.plan.target)
      })
    }
  }

  // ── Step 18: Create foreign keys ──
  if (isContract) {
    step("create-fks", "Creating foreign keys")
    await callDirectStep("create-fks", async () => {
      await createDatasetFKs(host, tgtPool, contractName!, input.plan.target)
    })
  }

  // ── Step 19: Deploy ETL2 custom transformation ──
  if (isContract) {
    step("deploy-etl", "Deploying ETL custom transformations")
    await callDirectStep("deploy-etl", async () => {
      await deployETL(host, tgtPool, contractName!, input.plan.target)
    })
  }

  // ── Step 20: Deploy routine ──
  if (isContract) {
    step("deploy-routine", "Deploying routines")
    await callDirectStep("deploy-routine", async () => {
      await deployRoutine(host, tgtPool, contractName!, input.plan.target)
    })
  }

  // ── Step 21: Deploy post-script ──
  if (isContract) {
    step("deploy-post-script", "Running post-deployment scripts")
    await callDirectStep("deploy-post-script", async () => {
      await runContractDeploymentScriptsDirect(host, tgtPool, contractName!, "Run postScript", input.plan.target)
    })
  }

  // ── Step 22: Unlock after deployment ──
  if (isContract) {
    step("unlock-after-deploy", "Unlocking after deployment")
    await callDirectStep("unlock-after-deploy", async () => {
      await setContractLockDirect(host, tgtPool, Number(entityId), false, input.plan.target)
    })
  }

  // ── Step 23: Set sync date at source ──
  step("set-sync-date", "Updating sync date on source")
  try {
    await runAuditCheckDirect(host, srcPool, {
      action: "syncDate",
      id: entityId,
      objType: isContract ? "Contract" : entityType,
    }, input.plan.source)
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.warn(`[sync.execute] syncDate update failed:`, e)
    stepWarnings.push({ step: "set-sync-date", sproc: "direct", error: errMsg })
    onProgress({ type: SyncProgressKind.Step, step: "set-sync-date", message: "set-sync-date (direct) failed", error: errMsg })
    emit(host, EventType.SyncExecuteStepFailed, { planId, step: "set-sync-date", sproc: "direct", error: errMsg })
  }

  // ── Step 24: Update deployment date on target ──
  step("set-deploy-date", "Updating deployment date on target")
  try {
    await runAuditCheckDirect(host, tgtPool, {
      action: "deployDate",
      id: entityId,
      objType: isContract ? "Contract" : entityType,
    }, input.plan.target)
  } catch (e) { console.warn(`[sync.execute] deployDate update failed:`, e) }

  return { stepWarnings }
}
