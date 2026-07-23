/**
 * Definition-driven flow step executor.
 */

import type { ConnectionPool } from "mssql"
import type { SyncFlowKindDefinition, CustomValueSourceCatalog } from "@mia/shared-types"
import { METADATA_SYNC_KIND_ID } from "@mia/shared-types"
import type { HttpPort } from "../../../ports/http.js"
import type { SyncRuntimeHost } from "../../../ports/index.js"
import type { SyncTelemetryContext } from "../../events.js"
import type { SyncExecutionContractStep, SyncPlan } from "../../plan-store.js"
import { runCustomShellFlowStep, runCustomSqlFlowStep } from "./custom-handlers.js"
import { resolveContractName } from "./contract-deploy.js"
import { executeMssqlProcedure } from "./procedure-params.js"
import { runHttpFlowStep } from "./http-flow-step.js"
import type { StepOutputRegistry } from "./step-output-registry.js"

export interface FlowStepRunResult {
  createsDatasetLayer?: boolean
  outputs: Record<string, unknown>
}

export interface FlowStepRunContext {
  host: SyncRuntimeHost
  plan: SyncPlan
  entityId: string | number
  entityType: string
  srcPool: ConnectionPool
  tgtPool: ConnectionPool
  telemetryContext?: SyncTelemetryContext
  userUpn?: string | null
  resolveContractName: () => Promise<string>
  customValueSources: CustomValueSourceCatalog
  stepOutputs: StepOutputRegistry
  http?: HttpPort
}

export async function runCatalogFlowStep(
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
  kindDef: SyncFlowKindDefinition,
): Promise<FlowStepRunResult> {
  const handler = kindDef.handler
  switch (handler.type) {
    case "metadata_sync":
      throw new Error(`${METADATA_SYNC_KIND_ID} must run via runMetadataSync, not runCatalogFlowStep (${step.id}).`)
    case "mssql_procedure":
      return executeMssqlProcedure(ctx, step, kindDef)
    case "http_request":
      return runHttpFlowStep(ctx, step, kindDef)
    case "custom_sql":
      return runCustomSqlFlowStep(ctx, step, kindDef)
    case "custom_shell_script":
      return runCustomShellFlowStep(ctx, step, kindDef)
    default:
      throw new Error(`Step "${step.id}" (${step.kind}) has unsupported handler type.`)
  }
}

export function createContractNameResolver(
  ctx: Pick<FlowStepRunContext, "host" | "tgtPool" | "plan" | "entityId" | "telemetryContext">,
): { resolveContractName: () => Promise<string> } {
  let contractNamePromise: Promise<string> | null = null
  return {
    resolveContractName(): Promise<string> {
      if (!contractNamePromise) {
        const numericEntityId = typeof ctx.entityId === "number" ? ctx.entityId : Number(ctx.entityId)
        if (!Number.isFinite(numericEntityId)) {
          throw new Error(`Contract step requires a numeric entity id; got ${String(ctx.entityId)}.`)
        }
        contractNamePromise = resolveContractName(
          ctx.host,
          ctx.tgtPool,
          numericEntityId,
          ctx.plan.target,
          ctx.telemetryContext,
        )
      }
      return contractNamePromise
    },
  }
}
