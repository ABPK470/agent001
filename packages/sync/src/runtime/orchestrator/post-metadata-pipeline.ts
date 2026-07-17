import type { ConnectionPool } from "mssql"

import type { FlowCatalog } from "../../domain/flow-catalog.js"
import { createsDatasetLayer } from "../../domain/flow-kind-dataset-layer.js"
import { assertPublishedOutputsPresent } from "@mia/shared-types"
import { EventType, SyncDeployStepStatus, SyncProgressKind, type SyncRuntimeHost } from "../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { type SyncExecutionContractStep, type SyncPlan } from "../plan-store.js"
import { createContractNameResolver, runCatalogFlowStep } from "./flow-step-executor.js"
import { StepOutputRegistry } from "./step-output-registry.js"
import { isAuditGateSkippedError, type ExecuteProgress } from "./types.js"

export interface StepWarning {
  step: string
  sproc: string
  error: string
}

export interface PostMetadataPipelineInput {
  host: SyncRuntimeHost
  tgtPool: ConnectionPool
  srcPool: ConnectionPool
  plan: SyncPlan
  planId: string
  entityId: string | number
  entityType: string
  onProgress: (p: ExecuteProgress) => void
  telemetryContext?: SyncTelemetryContext
  userUpn?: string | null
  steps: SyncExecutionContractStep[]
  flowCatalog: FlowCatalog
  /** When true, emit deploy-step progress (post-metadata / post-commit). */
  asDeploySteps?: boolean
}

export async function runPostMetadataPipeline(
  input: PostMetadataPipelineInput,
): Promise<{ stepWarnings: StepWarning[] }> {
  const { host, planId, onProgress, entityId, entityType, tgtPool, srcPool, userUpn } = input
  const catalog = input.flowCatalog
  const asDeploySteps = input.asDeploySteps ?? true
  const stepWarnings: StepWarning[] = []
  const isContractDeploy = entityType === "contract"
  let contractDatasetLayerOk = true

  const { resolveContractName } = createContractNameResolver({
    host,
    tgtPool,
    plan: input.plan,
    entityId,
    telemetryContext: input.telemetryContext,
  })

  const stepOutputs = new StepOutputRegistry()

  const stepCtx = {
    host,
    plan: input.plan,
    entityId,
    entityType,
    srcPool,
    tgtPool,
    telemetryContext: input.telemetryContext,
    userUpn,
    resolveContractName,
    customValueSources: catalog.snapForSteps(input.steps).customValueSources,
    stepOutputs,
  }

  function emitDeployProgress(
    stepName: string,
    deployStatus: (typeof SyncDeployStepStatus)[keyof typeof SyncDeployStepStatus],
    message?: string,
    error?: string,
  ): void {
    onProgress({
      type: SyncProgressKind.DeployStep,
      step: stepName,
      deployStatus,
      message: message ?? stepName,
      error,
    })
  }

  function announceStep(stepName: string): void {
    emit(host, EventType.SyncExecuteStep, { planId, step: stepName })
    // In-flight tick for progress UI only — not an audit-log row (see exec-log-events.ts).
    emitDeployProgress(stepName, SyncDeployStepStatus.Started, stepName)
  }

  async function runStep(
    entry: SyncExecutionContractStep,
    fn: () => Promise<void>,
    options?: { fatal?: boolean },
  ): Promise<boolean> {
    const stepName = entry.id
    if (asDeploySteps) announceStep(stepName)
    else {
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: entry.description ?? stepName })
      emit(host, EventType.SyncExecuteStep, { planId, step: stepName })
    }
    try {
      await fn()
      if (asDeploySteps) emitDeployProgress(stepName, SyncDeployStepStatus.Done, entry.description ?? stepName)
      return true
    } catch (e) {
      if (isAuditGateSkippedError(e)) throw e
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} failed:`, e)
      stepWarnings.push({ step: stepName, sproc: "direct", error: errMsg })
      if (asDeploySteps) {
        emitDeployProgress(stepName, SyncDeployStepStatus.Failed, `${stepName} failed`, errMsg)
      } else {
        onProgress({
          type: SyncProgressKind.Step,
          step: stepName,
          message: `${stepName} failed`,
          error: errMsg,
        })
      }
      emit(host, EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: "direct", error: errMsg })
      if (options?.fatal) throw e
      return false
    }
  }

  function skipStep(stepName: string, reason: string): void {
    stepWarnings.push({ step: stepName, sproc: "skipped", error: reason })
    emitDeployProgress(stepName, SyncDeployStepStatus.Skipped, reason)
    emit(host, EventType.SyncExecuteStep, { planId, step: stepName })
  }

  for (const entry of input.steps) {
    const kindDef = catalog.resolveKind(entry.kind)
    if (!kindDef) {
      const stepName = entry.id
      const errMsg = `Unknown step kind "${entry.kind}" — step skipped.`
      stepWarnings.push({ step: stepName, sproc: "skipped", error: errMsg })
      if (asDeploySteps) skipStep(stepName, errMsg)
      else {
        onProgress({ type: SyncProgressKind.Step, step: stepName, message: errMsg, error: errMsg })
      }
      continue
    }

    if (isContractDeploy && !contractDatasetLayerOk && kindDef.skipWhenDatasetLayerFailed) {
      skipStep(entry.id, `Skipped ${entry.id}: contract physical dataset layer failed earlier.`)
      continue
    }

    const fatal = kindDef.failureMode === "fatal"
    const ok = await runStep(
      entry,
      async () => {
        const result = await runCatalogFlowStep(stepCtx, entry, kindDef)
        stepOutputs.publish(entry.id, result.outputs)
        assertPublishedOutputsPresent(entry.kind, kindDef, result.outputs)
      },
      { fatal },
    )
    if (!ok && createsDatasetLayer(kindDef)) contractDatasetLayerOk = false
  }

  return { stepWarnings }
}
