/**
 * HTTP request handler — single path: resolve httpBody slots, send JSON.
 * Emits sync.execute.http so Pipelines can show request/response detail
 * the same way SQL steps show query detail.
 */

import type { SyncFlowKindDefinition } from "@mia/shared-types"
import { handlerInputSlots, lookupHttpServiceSlot } from "@mia/shared-types"
import { getEnvironment } from "../../domain/environments.js"
import { resolveEnvServiceUrl } from "../../domain/env-service-urls.js"
import { emitSyncHttpEvent } from "../events.js"
import type { SyncExecutionContractStep } from "../plan-store.js"
import type { FlowStepRunContext, FlowStepRunResult } from "./flow-step-executor.js"
import { resolveHandlerInputs } from "./handler-inputs.js"
import { mergeHandlerResultOutputs, parseFlatJsonText } from "./step-output-registry.js"

export async function runHttpFlowStep(
  ctx: FlowStepRunContext,
  step: SyncExecutionContractStep,
  kindDef: SyncFlowKindDefinition,
): Promise<FlowStepRunResult> {
  const handler = kindDef.handler
  const path = handler.httpPath?.trim()
  if (!path) {
    throw new Error(`Step "${step.id}" (${step.kind}) is missing httpPath.`)
  }

  const method = handler.httpMethod ?? "POST"
  const slots = handlerInputSlots(handler)
  if (method !== "GET" && slots.length === 0) {
    throw new Error(
      `Step "${step.id}" (${step.kind}) requires httpBody input slots for ${method} requests.`,
    )
  }

  const environment = getEnvironment(ctx.host, ctx.plan.target)
  const baseUrl = resolveHttpBaseUrl(environment, handler.httpService)
  const url = `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`

  const body = slots.length > 0 ? await resolveHandlerInputs(slots, ctx, step) : {}
  const started = Date.now()
  try {
    const { status, responseBody } = await httpJson(method, url, method === "GET" ? undefined : body)
    emitSyncHttpEvent(ctx.host, {
      planId: ctx.plan.planId,
      step: step.id,
      method,
      url,
      status,
      durationMs: Date.now() - started,
      requestBody: method === "GET" ? null : body,
      responseBody,
    })
    return { outputs: mergeHandlerResultOutputs(body, responseBody) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const statusMatch = message.match(/failed with (\d{3}):/)
    emitSyncHttpEvent(ctx.host, {
      planId: ctx.plan.planId,
      step: step.id,
      method,
      url,
      status: statusMatch ? Number(statusMatch[1]) : 0,
      durationMs: Date.now() - started,
      requestBody: method === "GET" ? null : body,
      responseBody: null,
      error: message,
    })
    throw error
  }
}

function resolveHttpBaseUrl(
  environment: ReturnType<typeof getEnvironment>,
  service: "etl" | "agent" | "gate" | undefined,
): string {
  const key = (service ?? "etl").trim().toLowerCase()
  const trimmed = resolveEnvServiceUrl(environment, key)
  if (!trimmed) {
    const label = (() => {
      try {
        return lookupHttpServiceSlot(service ?? "etl").label
      } catch {
        return key
      }
    })()
    throw new Error(
      `Environment "${environment.name}" is missing ${label} base URL (${key}). Configure it under Configuration → Targets.`,
    )
  }
  return trimmed
}

async function httpJson(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; responseBody: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${method} ${url} failed with ${response.status}: ${text || response.statusText}`)
  }
  return { status: response.status, responseBody: parseFlatJsonText(text) }
}
