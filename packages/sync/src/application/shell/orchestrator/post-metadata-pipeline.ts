import sqlMod, { type ConnectionPool } from "mssql"

import { PostMetadataActionKind } from "../../../domain/enums.js"
import { getEnvironment } from "../../../domain/environments.js"
import { EventType, SyncProgressKind, type AgentHost } from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { type SyncPlan } from "../plan-store.js"
import { runAuditCheckDirect } from "./contract-deploy.js"
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import { runContractPipeline, type StepWarning } from "./execute-pipeline.js"
import type { ExecuteProgress } from "./types.js"

export interface PostMetadataPipelineInput {
  host: AgentHost
  tgtPool: ConnectionPool
  srcPool: ConnectionPool
  plan: SyncPlan
  planId: string
  entityId: string | number
  entityType: string
  onProgress: (p: ExecuteProgress) => void
  telemetryContext?: SyncTelemetryContext
  userUpn?: string | null
}

export async function runPostMetadataPipeline(input: PostMetadataPipelineInput): Promise<{ stepWarnings: StepWarning[] }> {
  const { host, planId, onProgress, entityId, entityType, tgtPool, srcPool, userUpn } = input
  const stepWarnings: StepWarning[] = []

  async function callStep(stepName: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(`[sync.execute] ${stepName} failed:`, e)
      stepWarnings.push({ step: stepName, sproc: "direct", error: errMsg })
      onProgress({ type: SyncProgressKind.Step, step: stepName, message: `${stepName} failed`, error: errMsg })
      emit(host, EventType.SyncExecuteStepFailed, { planId, step: stepName, sproc: "direct", error: errMsg })
    }
  }

  function step(name: string, message?: string) {
    onProgress({ type: SyncProgressKind.Step, step: name, message: message ?? name })
    emit(host, EventType.SyncExecuteStep, { planId, step: name })
  }

  for (const action of input.plan.recipeSnapshot.postMetadataActions) {
    switch (action.kind) {
      case PostMetadataActionKind.ContractDeploy: {
        const { stepWarnings: contractWarnings } = await runContractPipeline({
          host,
          tgtPool,
          srcPool,
          plan: input.plan,
          planId,
          entityId,
          entityType,
          onProgress,
          telemetryContext: input.telemetryContext,
        })
        stepWarnings.push(...contractWarnings)
        break
      }
      case PostMetadataActionKind.DatasetDeploy: {
        step("dataset-deploy", "Deploying dataset on target ETL service")
        await callStep("dataset-deploy", async () => {
          const datasetId = entityType === "rule"
            ? await resolveRuleInputDatasetId(host, tgtPool, input.plan.target, entityId, input.telemetryContext)
            : entityId
          await runDatasetDeploy(host, input.plan.target, datasetId, userUpn)
        })
        break
      }
      case PostMetadataActionKind.RulesDeploy: {
        step("rules-deploy", "Deploying rules on target ETL service")
        await callStep("rules-deploy", async () => {
          await runRulesDeploy(host, input.plan.target, entityId, userUpn)
        })
        break
      }
      case PostMetadataActionKind.PipelineRegister: {
        step("pipeline-register", "Registering pipeline on target Agent service")
        await callStep("pipeline-register", async () => {
          const pipelineId = entityType === "contract"
            ? await resolveContractPipelineId(host, tgtPool, input.plan.target, entityId, input.telemetryContext)
            : entityId
          await runPipelineRegister(host, input.plan.target, pipelineId)
        })
        break
      }
      case PostMetadataActionKind.MetaRefresh: {
        step("meta-refresh", "Refreshing Gate metadata on target Gate service")
        await callStep("meta-refresh", async () => {
          await runMetaRefresh(host, input.plan.target)
        })
        break
      }
      case PostMetadataActionKind.PipelineStart: {
        step("pipeline-start", "Starting target Agent pipeline for list content population")
        await callStep("pipeline-start", async () => {
          await runPipelineStartByName(host, input.plan.target, "All Lists content item population")
        })
        break
      }
      case PostMetadataActionKind.HandleDependencies: {
        step("handle-dependencies", `Refreshing ${entityType} dependencies on target`)
        await callStep("handle-dependencies", async () => {
          await runHandleDependencies(host, tgtPool, input.plan.target, entityType, entityId, input.telemetryContext)
        })
        break
      }
      case PostMetadataActionKind.SyncDate: {
        step("set-sync-date", "Updating sync date on source")
        await callStep("set-sync-date", async () => {
          await runAuditCheckDirect(host, srcPool, {
            action: "syncDate",
            id: entityId,
            objType: auditObjectType(entityType),
          }, input.plan.source, undefined, input.telemetryContext)
        })
        break
      }
      case PostMetadataActionKind.DeployDate: {
        step("set-deploy-date", "Updating deployment date on target")
        await callStep("set-deploy-date", async () => {
          await runAuditCheckDirect(host, tgtPool, {
            action: "deployDate",
            id: entityId,
            objType: auditObjectType(entityType),
          }, input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      default:
        break
    }
  }

  return { stepWarnings }
}

function auditObjectType(entityType: string): string {
  switch (entityType) {
    case "contract":
      return "Contract"
    case "dataset":
      return "Dataset"
    case "rule":
      return "Rule"
    case "content":
      return "Content"
    case "pipelineActivity":
      return "Pipeline"
    case "gateMetadata":
      return "MetaTable"
    default:
      return entityType
  }
}

async function runDatasetDeploy(
  host: AgentHost,
  environmentName: string,
  entityId: string | number,
  userUpn?: string | null,
): Promise<void> {
  const environment = getEnvironment(host, environmentName)
  const baseUrl = environment.etlServiceBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      `Environment "${environmentName}" is missing etlServiceBaseUrl; dataset post-metadata deploy cannot run.`,
    )
  }

  const numericDatasetId = typeof entityId === "number" ? entityId : Number(entityId)
  const requestBody = Number.isFinite(numericDatasetId)
    ? { datasetId: numericDatasetId, userFullName: userUpn ?? undefined }
    : { name: String(entityId), userFullName: userUpn ?? undefined }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/dataset/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Dataset deploy failed with ${response.status}: ${body || response.statusText}`)
  }
}

async function runRulesDeploy(
  host: AgentHost,
  environmentName: string,
  entityId: string | number,
  userUpn?: string | null,
): Promise<void> {
  const environment = getEnvironment(host, environmentName)
  const baseUrl = environment.etlServiceBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      `Environment "${environmentName}" is missing etlServiceBaseUrl; rules post-metadata deploy cannot run.`,
    )
  }

  const numericRuleId = typeof entityId === "number" ? entityId : Number(entityId)
  if (!Number.isFinite(numericRuleId)) {
    throw new Error(`Rule deploy requires a numeric rule id; got ${String(entityId)}.`)
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rules/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ruleId: numericRuleId,
      userFullName: userUpn ?? undefined,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Rules deploy failed with ${response.status}: ${body || response.statusText}`)
  }
}

async function runPipelineRegister(
  host: AgentHost,
  environmentName: string,
  entityId: string | number,
): Promise<void> {
  const environment = getEnvironment(host, environmentName)
  const baseUrl = environment.agentServiceBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      `Environment "${environmentName}" is missing agentServiceBaseUrl; pipeline registration cannot run.`,
    )
  }

  const numericPipelineId = typeof entityId === "number" ? entityId : Number(entityId)
  if (!Number.isFinite(numericPipelineId)) {
    throw new Error(`Pipeline registration requires a numeric pipeline id; got ${String(entityId)}.`)
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/pipeline/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pipelineId: numericPipelineId }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Pipeline registration failed with ${response.status}: ${body || response.statusText}`)
  }
}

async function runMetaRefresh(
  host: AgentHost,
  environmentName: string,
): Promise<void> {
  const environment = getEnvironment(host, environmentName)
  const baseUrl = environment.gateServiceBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      `Environment "${environmentName}" is missing gateServiceBaseUrl; gate metadata refresh cannot run.`,
    )
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/meta/refresh`, {
    method: "GET",
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gate metadata refresh failed with ${response.status}: ${body || response.statusText}`)
  }
}

async function runPipelineStartByName(
  host: AgentHost,
  environmentName: string,
  pipelineName: string,
): Promise<void> {
  const environment = getEnvironment(host, environmentName)
  const baseUrl = environment.agentServiceBaseUrl?.trim()
  if (!baseUrl) {
    throw new Error(
      `Environment "${environmentName}" is missing agentServiceBaseUrl; pipeline start cannot run.`,
    )
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/pipeline/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: pipelineName }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Pipeline start failed with ${response.status}: ${body || response.statusText}`)
  }
}

async function resolveRuleInputDatasetId(
  host: AgentHost,
  pool: ConnectionPool,
  connection: string,
  ruleId: string | number,
  telemetryContext?: SyncTelemetryContext,
): Promise<number> {
  const numericRuleId = typeof ruleId === "number" ? ruleId : Number(ruleId)
  if (!Number.isFinite(numericRuleId)) {
    throw new Error(`Rule input dataset lookup requires a numeric rule id; got ${String(ruleId)}.`)
  }

  const req = pool.request()
  req.input("ruleId", sqlMod.Int, numericRuleId)
  const result = await trackedQuery<{ inputDatasetId: number | null }>(
    host,
    req,
    "SELECT inputDatasetId FROM core.[Rule] WHERE ruleId = @ruleId",
    `postMetadata.resolveRuleInputDatasetId(${numericRuleId})`,
    connection,
    telemetryContext,
  )

  const datasetId = result.recordset?.[0]?.inputDatasetId
  if (typeof datasetId !== "number") {
    throw new Error(`Rule ${numericRuleId} does not have an inputDatasetId on target after metadata sync.`)
  }

  return datasetId
}

async function resolveContractPipelineId(
  host: AgentHost,
  pool: ConnectionPool,
  connection: string,
  contractId: string | number,
  telemetryContext?: SyncTelemetryContext,
): Promise<number> {
  const numericContractId = typeof contractId === "number" ? contractId : Number(contractId)
  if (!Number.isFinite(numericContractId)) {
    throw new Error(`Contract pipeline lookup requires a numeric contract id; got ${String(contractId)}.`)
  }

  const req = pool.request()
  req.input("contractId", sqlMod.Int, numericContractId)
  const result = await trackedQuery<{ pipelineId: number | null }>(
    host,
    req,
    "SELECT pipelineId FROM core.Pipeline WHERE contractId = @contractId",
    `postMetadata.resolveContractPipelineId(${numericContractId})`,
    connection,
    telemetryContext,
  )

  const pipelineId = result.recordset?.[0]?.pipelineId
  if (typeof pipelineId !== "number") {
    throw new Error(`Contract ${numericContractId} does not have a target pipelineId after metadata sync.`)
  }

  return pipelineId
}

async function runHandleDependencies(
  host: AgentHost,
  pool: ConnectionPool,
  connection: string,
  entityType: string,
  entityId: string | number,
  telemetryContext?: SyncTelemetryContext,
): Promise<void> {
  const objectType = entityType.toLowerCase()
  const actionName = `${objectType}Sync`
  const req = pool.request()
  req.input("id", sqlMod.VarChar(50), String(entityId))
  req.input("objectName", sqlMod.VarChar(100), objectType)
  req.input("actionName", sqlMod.VarChar(100), actionName)

  await trackedExecute(
    host,
    req,
    "core.uspObjectDependencies",
    `postMetadata.handleDependencies(${objectType}/${entityId})`,
    connection,
    telemetryContext,
  )
}