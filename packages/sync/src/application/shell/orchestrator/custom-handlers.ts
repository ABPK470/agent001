/**
 * Custom SQL batch and shell command flow-step handlers.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import sqlMod from "mssql"

import type { SyncFlowKindDefinition } from "@mia/shared-types"
import { handlerInputSlots, substituteInputTokens } from "@mia/shared-types"
import { assertEnvOperationAllowed } from "../../../domain/governance/env-operations.js"
import { getEnvironment } from "../../../domain/environments.js"
import type { FlowStepRunContext, FlowStepRunResult } from "./flow-step-executor.js"
import type { SyncExecutionContractStep } from "../plan-store.js"
import { resolveHandlerInputs } from "./handler-inputs.js"
import { mergeHandlerResultOutputs, mergeShellCommandOutputs } from "./step-output-registry.js"
import { trackedQuery } from "./db-helpers.js"

const execFileAsync = promisify(execFile)

const DEFAULT_SHELL_TIMEOUT_MS = 120_000

export async function runCustomSqlFlowStep(
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
  kindDef: SyncFlowKindDefinition,
): Promise<FlowStepRunResult> {
  const handler = kindDef.handler
  const sqlBatch = handler.sqlBatch?.trim()
  if (!sqlBatch) {
    throw new Error(`Step "${step.id}" (${step.kind}) is missing SQL batch text.`)
  }

  const connectionName = handler.connection === "source" ? ctx.plan.source : ctx.plan.target
  const env = getEnvironment(ctx.host, connectionName)
  assertEnvOperationAllowed(env, "sync_custom_sql")

  const values = await resolveHandlerInputs(handlerInputSlots(handler), ctx, step)
  const batch = substituteInputTokens(sqlBatch, values)

  const pool = handler.connection === "source" ? ctx.srcPool : ctx.tgtPool
  const req = pool.request()
  for (const [name, raw] of Object.entries(values)) {
    bindSqlInput(req, name, raw)
  }

  const queryResult = await trackedQuery(
    ctx.host,
    connectionName,
    batch,
    `flowStep.${step.kind}(${step.id})`,
    ctx.telemetryContext,
    req,
  )

  return { outputs: mergeHandlerResultOutputs(values, queryResult) }
}

export async function runCustomShellFlowStep(
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
  kindDef: SyncFlowKindDefinition,
): Promise<FlowStepRunResult> {
  const handler = kindDef.handler
  const shellCommand = handler.shellCommand?.trim()
  if (!shellCommand) {
    throw new Error(`Step "${step.id}" (${step.kind}) is missing shell command.`)
  }

  const policyEnvName = handler.connection === "source" ? ctx.plan.source : ctx.plan.target
  const env = getEnvironment(ctx.host, policyEnvName)
  assertEnvOperationAllowed(env, "sync_shell_execute")

  const values = await resolveHandlerInputs(handlerInputSlots(handler), ctx, step)
  const command = substituteInputTokens(shellCommand, values)

  const platform = handler.shellPlatform ?? "any"
  const { stdout } = await runShellOnHost(command, platform, {
    label: `flowStep.${step.kind}(${step.id})`,
    telemetryContext: ctx.telemetryContext,
    host: ctx.host,
  })

  return { outputs: mergeShellCommandOutputs(values, stdout) }
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

export async function runShellOnHost(
  command: string,
  platform: "linux" | "windows" | "any",
  opts: {
    label: string
    timeoutMs?: number
    telemetryContext?: import("../events.js").SyncTelemetryContext
    host: FlowStepRunContext["host"]
  },
): Promise<{ stdout: string; stderr: string }> {
  const hostPlatform = process.platform === "win32" ? "windows" : "linux"
  if (platform !== "any" && platform !== hostPlatform) {
    throw new Error(
      `Shell platform "${platform}" does not match sync host (${hostPlatform}).`,
    )
  }

  const useWindows = platform === "windows" || (platform === "any" && hostPlatform === "windows")
  const executable = useWindows ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh"
  const args = useWindows ? ["/d", "/s", "/c", command] : ["-c", command]
  const timeout = opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS

  try {
    const result = await execFileAsync(executable, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })
    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`Shell command failed (${opts.label}): ${message}`)
  }
}
