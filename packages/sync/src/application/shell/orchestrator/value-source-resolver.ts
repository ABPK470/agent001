/**
 * Resolve ValueSource at execute time — single resolver for all handler inputs.
 */

import sqlMod, { type ConnectionPool } from "mssql"

import type { CustomValueSourceCatalog, ValueSource } from "@mia/shared-types"
import {
  BUILTIN_TARGET_SQL,
  effectiveTargetSqlResultType,
  isLiteralValueSource,
  lookupCustomValueSource,
  readStepFieldValue,
  validateTargetSqlQuery,
} from "@mia/shared-types"

import type { SyncRuntimeHost } from "../../../ports/index.js"
import type { SyncTelemetryContext } from "../events.js"
import type { SyncPlan } from "../plan-store.js"
import type { StepOutputRegistry } from "./step-output-registry.js"
import { trackedQuery } from "./db-helpers.js"
import type { SyncExecutionContractStep } from "../plan-store.js"

export interface ValueSourceResolveContext {
  host: SyncRuntimeHost
  plan: SyncPlan
  entityId: string | number
  entityType: string
  srcPool: ConnectionPool
  tgtPool: ConnectionPool
  telemetryContext?: SyncTelemetryContext
  userUpn?: string | null
  stepOutputs: StepOutputRegistry
  customValueSources: CustomValueSourceCatalog
}

export async function resolveValueSource(
  source: ValueSource,
  ctx: ValueSourceResolveContext,
  step: Pick<SyncExecutionContractStep, "id"> & Record<string, unknown>,
): Promise<unknown> {
  if (isLiteralValueSource(source)) {
    return source.value
  }

  switch (source.type) {
    case "planEntityId":
      return ctx.entityId
    case "planActor": {
      if (!ctx.userUpn?.trim()) {
        throw new Error("Value source planActor requires userUpn on sync run context.")
      }
      return ctx.userUpn.trim()
    }
    case "currentStepId":
      return step.id
    case "contractName":
      return resolveTargetSqlBinding(
        BUILTIN_TARGET_SQL.contractName.query,
        BUILTIN_TARGET_SQL.contractName.resultColumn,
        ctx,
        "contractName",
        BUILTIN_TARGET_SQL.contractName.resultType,
      )
    case "ruleInputDatasetId":
      return resolveTargetSqlBinding(
        BUILTIN_TARGET_SQL.ruleInputDatasetId.query,
        BUILTIN_TARGET_SQL.ruleInputDatasetId.resultColumn,
        ctx,
        "ruleInputDatasetId",
        BUILTIN_TARGET_SQL.ruleInputDatasetId.resultType,
      )
    case "contractPipelineId":
      return resolveTargetSqlBinding(
        BUILTIN_TARGET_SQL.contractPipelineId.query,
        BUILTIN_TARGET_SQL.contractPipelineId.resultColumn,
        ctx,
        "contractPipelineId",
        BUILTIN_TARGET_SQL.contractPipelineId.resultType,
      )
    case "stepField":
      return readStepFieldValue(step, source.field)
    case "priorOutput":
      return ctx.stepOutputs.get(source.stepId, source.output)
    case "catalog": {
      const def = lookupCustomValueSource(ctx.customValueSources, source.id)
      return resolveTargetSqlBinding(
        def.query,
        def.resultColumn,
        ctx,
        `custom value source ${source.id}`,
        effectiveTargetSqlResultType(def),
      )
    }
    default:
      throw new Error(`Unsupported value source type "${String((source as { type?: string }).type)}".`)
  }
}

export async function resolveTargetSqlBinding(
  query: string,
  resultColumn: string,
  ctx: Pick<ValueSourceResolveContext, "entityId" | "tgtPool" | "plan" | "host" | "telemetryContext">,
  label: string,
  resultType: "string" | "number" = "number",
): Promise<string | number> {
  const queryError = validateTargetSqlQuery(query)
  if (queryError) throw new Error(`${label}: ${queryError}`)
  const numericEntityId = typeof ctx.entityId === "number" ? ctx.entityId : Number(ctx.entityId)
  if (!Number.isFinite(numericEntityId)) {
    throw new Error(`${label} requires a numeric entity id; got ${String(ctx.entityId)}.`)
  }
  const req = ctx.tgtPool.request()
  req.input("entityId", sqlMod.Int, numericEntityId)
  const result = await trackedQuery<Record<string, unknown>>(
    ctx.host,
    ctx.plan.target,
    query.trim(),
    `targetSql.${resultColumn}(${numericEntityId})`,
    ctx.telemetryContext,
    req,
  )
  const row = result.recordset?.[0]
  const raw = row?.[resultColumn]
  if (resultType === "string") {
    if (typeof raw === "string" && raw.trim()) return raw.trim()
    if (raw != null && String(raw).trim()) return String(raw).trim()
    throw new Error(`${label} returned no text ${resultColumn} for entity ${numericEntityId}.`)
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) return Number(raw)
  throw new Error(`${label} returned no numeric ${resultColumn} for entity ${numericEntityId}.`)
}
