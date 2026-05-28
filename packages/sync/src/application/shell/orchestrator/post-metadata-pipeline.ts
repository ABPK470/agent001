import sqlMod, { type ConnectionPool } from "mssql"

import { PostMetadataActionKind } from "../../../domain/enums.js"
import { getEnvironment } from "../../../domain/environments.js"
import { EventType, SyncProgressKind, type AgentHost } from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { type SyncExecutionContractStep, type SyncPlan } from "../plan-store.js"
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
import { trackedExecute, trackedQuery } from "./db-helpers.js"
import type { ExecuteProgress } from "./types.js"

export interface StepWarning {
  step: string
  sproc: string
  error: string
}

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
  steps: SyncExecutionContractStep[]
}

export async function runPostMetadataPipeline(input: PostMetadataPipelineInput): Promise<{ stepWarnings: StepWarning[] }> {
  const { host, planId, onProgress, entityId, entityType, tgtPool, srcPool, userUpn } = input
  const stepWarnings: StepWarning[] = []
  let contractNamePromise: Promise<string> | null = null

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

  function resolveContractNameOnce(): Promise<string> {
    if (!contractNamePromise) {
      const numericEntityId = typeof entityId === "number" ? entityId : Number(entityId)
      if (!Number.isFinite(numericEntityId)) {
        throw new Error(`Contract step requires a numeric entity id; got ${String(entityId)}.`)
      }
      contractNamePromise = resolveContractName(host, tgtPool, numericEntityId, input.plan.target, input.telemetryContext)
    }
    return contractNamePromise
  }

  const entries = input.steps

  for (const entry of entries) {
    const kind = entry.kind
    switch (kind) {
      case "targetLock": {
        const stepName = "id" in entry ? entry.id : "target-lock"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await setContractLockDirect(host, tgtPool, Number(entityId), true, input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "targetUnlock": {
        const stepName = "id" in entry ? entry.id : "target-unlock"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await setContractLockDirect(host, tgtPool, Number(entityId), false, input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "auditCheck": {
        const stepName = "id" in entry ? entry.id : "audit-check"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await runAuditCheckDirect(host, tgtPool, {
            action: "syncOrNot",
            objType: requireAuditObjectType(entry),
            id: entityId,
          }, input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractUndeploy": {
        const stepName = "id" in entry ? entry.id : "contract-undeploy"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await undeployMarkedContract(host, tgtPool, Number(entityId), input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractPreScript": {
        const stepName = "id" in entry ? entry.id : "contract-pre-script"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await runContractDeploymentScriptsDirect(host, tgtPool, await resolveContractNameOnce(), "Run preScript", input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractCreateStageDataset":
      case "contractCreateArchiveDataset":
      case "contractCreateListDataset":
      case "contractCreateDimDataset":
      case "contractCreateFactDataset": {
        const stepKind = String(entry.kind)
        const stepName = "id" in entry ? entry.id : stepKind
        const datasetType = contractDatasetTypeForKind(stepKind)
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await createDataset(host, tgtPool, Number(entityId), await resolveContractNameOnce(), datasetType, input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractCreateDatasetFks": {
        const stepName = "id" in entry ? entry.id : "contract-create-fks"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await createDatasetFKs(host, tgtPool, await resolveContractNameOnce(), input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractDeployEtl": {
        const stepName = "id" in entry ? entry.id : "contract-deploy-etl"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await deployETL(host, tgtPool, await resolveContractNameOnce(), input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractDeployRoutine": {
        const stepName = "id" in entry ? entry.id : "contract-deploy-routine"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await deployRoutine(host, tgtPool, await resolveContractNameOnce(), input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case "contractPostScript": {
        const stepName = "id" in entry ? entry.id : "contract-post-script"
        step(stepName, entry.description)
        await callStep(stepName, async () => {
          await runContractDeploymentScriptsDirect(host, tgtPool, await resolveContractNameOnce(), "Run postScript", input.plan.target, undefined, input.telemetryContext)
        })
        break
      }
      case PostMetadataActionKind.DatasetDeploy:
      case "datasetDeploy": {
        const stepName = "id" in entry ? entry.id : "dataset-deploy"
        step(stepName, "Deploying dataset on target ETL service")
        await callStep(stepName, async () => {
          const datasetId = await resolveStepSubjectId(entry, {
            defaultEntityId: entityId,
            host,
            pool: tgtPool,
            connection: input.plan.target,
            telemetryContext: input.telemetryContext,
          })
          await runDatasetDeploy(host, input.plan.target, datasetId, userUpn)
        })
        break
      }
      case PostMetadataActionKind.RulesDeploy:
      case "rulesDeploy": {
        const stepName = "id" in entry ? entry.id : "rules-deploy"
        step(stepName, "Deploying rules on target ETL service")
        await callStep(stepName, async () => {
          await runRulesDeploy(host, input.plan.target, entityId, userUpn)
        })
        break
      }
      case PostMetadataActionKind.PipelineRegister:
      case "pipelineRegister": {
        const stepName = "id" in entry ? entry.id : "pipeline-register"
        step(stepName, "Registering pipeline on target Agent service")
        await callStep(stepName, async () => {
          const pipelineId = await resolveStepSubjectId(entry, {
            defaultEntityId: entityId,
            host,
            pool: tgtPool,
            connection: input.plan.target,
            telemetryContext: input.telemetryContext,
          })
          await runPipelineRegister(host, input.plan.target, pipelineId)
        })
        break
      }
      case PostMetadataActionKind.MetaRefresh:
      case "metaRefresh": {
        const stepName = "id" in entry ? entry.id : "meta-refresh"
        step(stepName, "Refreshing Gate metadata on target Gate service")
        await callStep(stepName, async () => {
          await runMetaRefresh(host, input.plan.target)
        })
        break
      }
      case PostMetadataActionKind.PipelineStart:
      case "pipelineStart": {
        const stepName = "id" in entry ? entry.id : "pipeline-start"
        step(stepName, "Starting target Agent pipeline for list content population")
        await callStep(stepName, async () => {
          await runPipelineStartByName(host, input.plan.target, requirePipelineName(entry))
        })
        break
      }
      case PostMetadataActionKind.HandleDependencies:
      case "handleDependencies": {
        const stepName = "id" in entry ? entry.id : "handle-dependencies"
        step(stepName, `Refreshing ${entityType} dependencies on target`)
        await callStep(stepName, async () => {
          await runHandleDependencies(host, tgtPool, input.plan.target, requireObjectName(entry), entityId, input.telemetryContext)
        })
        break
      }
      case PostMetadataActionKind.SyncDate:
      case "syncDate": {
        const stepName = "id" in entry ? entry.id : "set-sync-date"
        step(stepName, "Updating sync date on source")
        await callStep(stepName, async () => {
          await runAuditCheckDirect(host, srcPool, {
            action: "syncDate",
            id: entityId,
            objType: requireAuditObjectType(entry),
          }, input.plan.source, undefined, input.telemetryContext)
        })
        break
      }
      case PostMetadataActionKind.DeployDate:
      case "deployDate": {
        const stepName = "id" in entry ? entry.id : "set-deploy-date"
        step(stepName, "Updating deployment date on target")
        await callStep(stepName, async () => {
          await runAuditCheckDirect(host, tgtPool, {
            action: "deployDate",
            id: entityId,
            objType: requireAuditObjectType(entry),
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

function contractDatasetTypeForKind(kind: string): "stage" | "archive" | "list" | "dim" | "fact" {
  switch (kind) {
    case "contractCreateStageDataset":
      return "stage"
    case "contractCreateArchiveDataset":
      return "archive"
    case "contractCreateListDataset":
      return "list"
    case "contractCreateDimDataset":
      return "dim"
    case "contractCreateFactDataset":
      return "fact"
    default:
      throw new Error(`Unsupported contract dataset step kind: ${kind}`)
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
  objectName: string,
  entityId: string | number,
  telemetryContext?: SyncTelemetryContext,
): Promise<void> {
  const req = pool.request()
  req.input("id", sqlMod.VarChar(50), String(entityId))
  req.input("objectName", sqlMod.VarChar(100), objectName)

  await trackedExecute(
    host,
    req,
    "core.uspObjectDependencies",
    `postMetadata.handleDependencies(${objectName}/${entityId})`,
    connection,
    telemetryContext,
  )
}

function requireAuditObjectType(step: SyncExecutionContractStep): string {
  if (typeof step.auditObjectType === "string" && step.auditObjectType.trim().length > 0) return step.auditObjectType
  throw new Error(`Execution contract step ${step.id} is missing auditObjectType.`)
}

function requireObjectName(step: SyncExecutionContractStep): string {
  if (typeof step.objectName === "string" && step.objectName.trim().length > 0) return step.objectName
  throw new Error(`Execution contract step ${step.id} is missing objectName.`)
}

function requirePipelineName(step: SyncExecutionContractStep): string {
  if (typeof step.pipelineName === "string" && step.pipelineName.trim().length > 0) return step.pipelineName
  throw new Error(`Execution contract step ${step.id} is missing pipelineName.`)
}

async function resolveStepSubjectId(
  step: SyncExecutionContractStep,
  input: {
    defaultEntityId: string | number
    host: AgentHost
    pool: ConnectionPool
    connection: string
    telemetryContext?: SyncTelemetryContext
  },
): Promise<string | number> {
  switch (step.subjectRef ?? "entityId") {
    case "entityId":
      return input.defaultEntityId
    case "ruleInputDatasetId":
      return resolveRuleInputDatasetId(input.host, input.pool, input.connection, input.defaultEntityId, input.telemetryContext)
    case "contractPipelineId":
      return resolveContractPipelineId(input.host, input.pool, input.connection, input.defaultEntityId, input.telemetryContext)
    default:
      throw new Error(`Execution contract step ${step.id} has unsupported subjectRef ${String(step.subjectRef)}.`)
  }
}