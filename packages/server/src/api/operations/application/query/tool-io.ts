/**
 * Structured tool-call I/O for agent-run operation activities.
 */

import { EventType } from "@mia/agent"
import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"
import type { OperationEvent } from "./types.js"
import { numField, strField } from "./utils.js"

export interface ToolIoDetails {
  tool: string
  stepId?: string
  status: "running" | "success" | "failed"
  argsSummary?: string
  inputFormatted?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  outputText?: string
  error?: string
  durationMs?: number | null
}

export function resolveStepToolName(data: Record<string, unknown>): string {
  return strField(data, "action") ?? strField(data, "tool") ?? strField(data, "name") ?? "step"
}

function formatStepOutput(output: Record<string, unknown>): string {
  const result = output["result"]
  if (typeof result === "string" && result.length > 0) return result
  if (Object.keys(output).length === 0) return "done"
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function truncateSummary(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + "…"
}

export function buildToolIoSummary(io: ToolIoDetails): string | undefined {
  const parts: string[] = []
  if (io.argsSummary) parts.push(io.argsSummary)
  if (io.status === "success" && io.outputText) {
    parts.push(truncateSummary(io.outputText, 80))
  }
  if (io.status === "failed" && io.error) parts.push(truncateSummary(io.error, 80))
  if (io.durationMs != null) parts.push(`${(io.durationMs / 1000).toFixed(1)}s`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

export function buildToolIoFromStepEvents(events: readonly OperationEvent[]): ToolIoDetails | null {
  let started: OperationEvent | undefined
  let ended: OperationEvent | undefined

  for (const ev of events) {
    if (ev.type === EventType.StepStarted) started = ev
    if (ev.type === EventType.StepCompleted || ev.type === EventType.StepFailed) ended = ev
  }
  if (!started && !ended) return null

  const baseData = started?.data ?? ended!.data
  const tool = resolveStepToolName(baseData)
  const stepId = strField(baseData, "stepId") ?? undefined
  const input = (started?.data["input"] as Record<string, unknown> | undefined) ?? undefined
  const inputRecord = input && typeof input === "object" ? input : {}
  const presentation = Object.keys(inputRecord).length > 0 ? presentToolCall(tool, inputRecord) : null

  let status: ToolIoDetails["status"] = "running"
  let output: Record<string, unknown> | undefined
  let outputText: string | undefined
  let error: string | undefined
  let durationMs: number | null | undefined

  if (ended?.type === EventType.StepCompleted) {
    status = "success"
    output = (ended.data["output"] as Record<string, unknown> | undefined) ?? {}
    outputText = formatStepOutput(output)
    durationMs = numField(ended.data, "durationMs")
  } else if (ended?.type === EventType.StepFailed) {
    status = "failed"
    error = strField(ended.data, "error") ?? "step failed"
    durationMs = numField(ended.data, "durationMs")
  }

  const io: ToolIoDetails = {
    tool,
    stepId,
    status,
    ...(presentation?.summary ? { argsSummary: presentation.summary } : {}),
    ...(Object.keys(inputRecord).length > 0
      ? { input: inputRecord, inputFormatted: serializeToolCallArgs(inputRecord) }
      : {}),
    ...(output ? { output, outputText } : {}),
    ...(error ? { error } : {}),
    durationMs: durationMs ?? null
  }

  return io
}

export function isAgentStepEventType(type: string): boolean {
  return (
    type === EventType.StepStarted ||
    type === EventType.StepCompleted ||
    type === EventType.StepFailed
  )
}
