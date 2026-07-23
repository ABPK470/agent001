/**
 * Stored procedure handler — resolve inputs, execute, publish outputs.
 */

import sqlMod from "mssql"

import type { SyncFlowKindDefinition } from "@mia/shared-types"
import { handlerInputSlots } from "@mia/shared-types"
import { createsDatasetLayer } from "../../../core/flow/flow-kind-dataset-layer.js"
import { assertAuditGateAllowsProceed } from "./contract-deploy.js"
import type { SyncExecutionContractStep } from "../../plan-store.js"
import type { FlowStepRunContext, FlowStepRunResult } from "./flow-step-executor.js"
import { formatMssqlExecLog, trackedExecute } from "../db/db-helpers.js"
import { resolveHandlerInputs } from "./handler-inputs.js"
import { mergeProcedureResultOutputs } from "./step-output-registry.js"

export async function executeMssqlProcedure(
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
  kindDef: SyncFlowKindDefinition,
): Promise<FlowStepRunResult> {
  const handler = kindDef.handler
  const procedure = handler.procedure?.trim()
  if (!procedure) throw new Error(`Step "${step.id}" (${step.kind}) is missing procedure name.`)

  const connectionName = handler.connection === "source" ? ctx.plan.source : ctx.plan.target
  const pool = handler.connection === "source" ? ctx.srcPool : ctx.tgtPool
  const req = pool.request()
  const values = await resolveHandlerInputs(handlerInputSlots(handler), ctx, step)
  applyProcedureInputs(req, values)

  const result = await trackedExecute(
    ctx.host,
    connectionName,
    procedure,
    `flowStep.${step.kind}(${step.id})`,
    ctx.telemetryContext,
    req,
    formatMssqlExecLog(procedure, values),
  )

  const action = values["action"]
  if (
    isAuditProcedure(procedure) &&
    (action === "syncOrNot" || action === "runOrNot") &&
    handler.connection === "source"
  ) {
    const row = (result.recordsets?.[0] as Array<{ status: string; message: string }> | undefined)?.[0]
    assertAuditGateAllowsProceed(
      row ? { status: row.status, message: row.message } : null,
      step.id,
      `${procedure}(${String(action)})`,
    )
  }

  return {
    createsDatasetLayer: createsDatasetLayer(kindDef) ? true : undefined,
    outputs: mergeProcedureResultOutputs(values, result),
  }
}

function applyProcedureInputs(req: sqlMod.Request, values: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(values)) {
    bindSqlInput(req, name, raw)
  }
}

function bindSqlInput(req: sqlMod.Request, name: string, raw: unknown): void {
  if (raw === null || raw === undefined) {
    req.input(name, sqlMod.VarChar, null)
    return
  }
  if (typeof raw === "boolean") {
    req.input(name, sqlMod.Bit, raw)
    return
  }
  if (typeof raw === "number") {
    req.input(name, Number.isInteger(raw) ? sqlMod.Int : sqlMod.Float, raw)
    return
  }
  req.input(name, sqlMod.VarChar, String(raw))
}

function isAuditProcedure(procedure: string): boolean {
  return procedure.toLowerCase().includes("uspauditruncheck")
}

export function formatProcedureSummary(handler: SyncFlowKindDefinition["handler"]): string | null {
  if (handler.type !== "mssql_procedure" || !handler.procedure?.trim()) return null
  const parts = [handler.procedure.trim()]
  for (const slot of handlerInputSlots(handler)) {
    const src = slot.source
    if (!src) continue
    const binding =
      src.type === "literal"
        ? `${slot.name}=${JSON.stringify(src.value)}`
        : src.type === "catalog"
          ? `${slot.name}←${src.id}`
          : `${slot.name}←${src.stepId}.${src.output}`
    parts.push(binding)
  }
  return parts.join(" — ")
}
