/**
 * Resolve ValueSource at execute time — catalog is the single authority for resolvers.
 */

import sqlMod, { type ConnectionPool } from "mssql"

import type { CustomValueSourceCatalog, CustomValueSourceDefinition, ValueSource } from "@mia/shared-types"
import {
  effectiveTargetSqlResultType,
  isLiteralValueSource,
  lookupCustomValueSource,
  readStepFieldValue,
  validateTargetSqlQuery,
  valueSourceCatalogId,
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
  step: Pick<SyncExecutionContractStep, "id" | "objectName" | "auditObjectType" | "pipelineName">,
): Promise<unknown> {
  if (isLiteralValueSource(source)) {
    return source.value
  }

  if (source.type === "priorOutput") {
    return ctx.stepOutputs.get(source.stepId, source.output)
  }

  const catalogId = valueSourceCatalogId(source)
  if (!catalogId) {
    throw new Error(`Unsupported value source type "${String((source as { type?: string }).type)}".`)
  }

  const def = lookupCustomValueSource(ctx.customValueSources, catalogId)
  return resolveCatalogDefinition(def, ctx, step, catalogId)
}

export async function resolveCatalogDefinition(
  def: CustomValueSourceDefinition,
  ctx: ValueSourceResolveContext,
  step: Pick<SyncExecutionContractStep, "id" | "objectName" | "auditObjectType" | "pipelineName">,
  label: string,
): Promise<unknown> {
  switch (def.resolver.kind) {
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
    case "stepField":
      return readStepFieldValue(step, def.resolver.field)
    case "targetSql":
      return resolveTargetSqlBinding(
        def.resolver.query,
        def.resolver.resultColumn,
        ctx,
        label,
        effectiveTargetSqlResultType(def.resolver),
      )
    default:
      throw new Error(`Unsupported catalog resolver kind for "${label}".`)
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
