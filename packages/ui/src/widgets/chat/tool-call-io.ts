/**
 * Tool-call I/O helpers for the Operation Log (mirrors server tool-io.ts shape).
 */

import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"
import type { OperationActivity, OperationEvent } from "../../client/index"

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

const STEP_EVENT_TYPES = new Set(["step.started", "step.completed", "step.failed"])

export function isAgentStepEventType(type: string): boolean {
  return STEP_EVENT_TYPES.has(type)
}

function resolveStepToolName(data: Record<string, unknown>): string {
  const action = data["action"]
  if (typeof action === "string" && action.length > 0) return action
  const tool = data["tool"]
  if (typeof tool === "string" && tool.length > 0) return tool
  const name = data["name"]
  if (typeof name === "string" && name.length > 0) return name
  return "step"
}

function formatOutput(output: Record<string, unknown>): string {
  const result = output["result"]
  if (typeof result === "string" && result.length > 0) return result
  if (Object.keys(output).length === 0) return "done"
  return JSON.stringify(output, null, 2)
}

export function readToolIoFromActivity(activity: OperationActivity): ToolIoDetails | null {
  const raw = activity.details?.["toolIo"]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  return raw as ToolIoDetails
}

const NON_TOOL_ACTIVITY_NAMES = new Set([
  "queued",
  "started",
  "completed",
  "failed",
  "cancelled",
  "step",
])

/** Last-resort I/O for named tool rows when step.* payloads were lost but the
 *  activity still carries a tool name + summary (partial window / synth step). */
export function coerceToolIoFromActivity(activity: OperationActivity): ToolIoDetails | null {
  const fromDetails = readToolIoFromActivity(activity)
  if (fromDetails) return fromDetails
  const fromEvents = buildToolIoFromStepEvents(activity.events)
  if (fromEvents) return fromEvents
  if (NON_TOOL_ACTIVITY_NAMES.has(activity.name)) return null
  if (activity.id.startsWith("telemetry:")) return null
  if (!/^[a-z][a-z0-9_]*$/.test(activity.name)) return null
  // Require a real args/output hint — bare duration is not enough (lifecycle rows).
  if (!activity.summary) return null
  const status: ToolIoDetails["status"] =
    activity.status === "failed" ? "failed" : activity.status === "running" ? "running" : "success"
  return {
    tool: activity.name,
    status,
    argsSummary: activity.summary,
    durationMs: activity.durationMs
  }
}

export function buildToolIoFromStepEvents(events: readonly OperationEvent[]): ToolIoDetails | null {
  let started: OperationEvent | undefined
  let ended: OperationEvent | undefined
  for (const ev of events) {
    if (ev.type === "step.started") started = ev
    if (ev.type === "step.completed" || ev.type === "step.failed") ended = ev
  }
  if (!started && !ended) return null

  const base = started?.data ?? ended!.data
  const tool = resolveStepToolName(base)
  const stepId = typeof base["stepId"] === "string" ? base["stepId"] : undefined
  const input = (started?.data["input"] as Record<string, unknown> | undefined) ?? {}
  const presentation = Object.keys(input).length > 0 ? presentToolCall(tool, input) : null

  let status: ToolIoDetails["status"] = "running"
  let output: Record<string, unknown> | undefined
  let outputText: string | undefined
  let error: string | undefined
  let durationMs: number | null | undefined

  if (ended?.type === "step.completed") {
    status = "success"
    output = (ended.data["output"] as Record<string, unknown> | undefined) ?? {}
    outputText = formatOutput(output)
    durationMs = typeof ended.data["durationMs"] === "number" ? ended.data["durationMs"] : null
  } else if (ended?.type === "step.failed") {
    status = "failed"
    error = typeof ended.data["error"] === "string" ? ended.data["error"] : "step failed"
    durationMs = typeof ended.data["durationMs"] === "number" ? ended.data["durationMs"] : null
  }

  return {
    tool,
    stepId,
    status,
    ...(presentation?.summary ? { argsSummary: presentation.summary } : {}),
    ...(Object.keys(input).length > 0
      ? { input, inputFormatted: serializeToolCallArgs(input) }
      : {}),
    ...(output ? { output, outputText } : {}),
    ...(error ? { error } : {}),
    durationMs: durationMs ?? null
  }
}

export function readToolIoFromEvent(ev: OperationEvent): ToolIoDetails | null {
  if (!isAgentStepEventType(ev.type)) return null
  const tool = resolveStepToolName(ev.data)
  const stepId = typeof ev.data["stepId"] === "string" ? ev.data["stepId"] : undefined

  if (ev.type === "step.started") {
    const input = (ev.data["input"] as Record<string, unknown> | undefined) ?? {}
    const presentation = Object.keys(input).length > 0 ? presentToolCall(tool, input) : null
    return {
      tool,
      stepId,
      status: "running",
      ...(presentation?.summary ? { argsSummary: presentation.summary } : {}),
      ...(Object.keys(input).length > 0
        ? { input, inputFormatted: serializeToolCallArgs(input) }
        : {})
    }
  }

  if (ev.type === "step.completed") {
    const output = (ev.data["output"] as Record<string, unknown> | undefined) ?? {}
    return {
      tool,
      stepId,
      status: "success",
      output,
      outputText: formatOutput(output),
      durationMs: typeof ev.data["durationMs"] === "number" ? ev.data["durationMs"] : null
    }
  }

  return {
    tool,
    stepId,
    status: "failed",
    error: typeof ev.data["error"] === "string" ? ev.data["error"] : "step failed",
    durationMs: typeof ev.data["durationMs"] === "number" ? ev.data["durationMs"] : null
  }
}

export function formatToolIoMeta(io: ToolIoDetails): string {
  const parts = [io.tool]
  if (io.argsSummary) parts.push(io.argsSummary)
  if (io.durationMs != null) parts.push(`${io.durationMs}ms`)
  if (io.status === "failed" && io.error) parts.push("failed")
  return parts.join(" · ")
}

export function stripToolIoForInlineDisplay(data: Record<string, unknown>): Record<string, unknown> {
  const { input: _i, output: _o, ...rest } = data
  return rest
}
