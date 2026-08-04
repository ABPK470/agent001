/**
 * Tool execution card — summary lines, input/output formatting (chat + trace).
 */

import { presentToolCallFromFormatted, toolCallDetailPreview } from "@mia/shared-types"
import { compactToolPreview } from "./events/build-chat-parts"
import { extractToolCode, formatToolInputDisplay } from "../components/tool-code-display"
import { formatMs } from "./util"

export type ToolExecStatus = "done" | "error" | "running" | "proposed"

export function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ")
}

export function resolveExecStatus(
  explicit: ToolExecStatus | undefined,
  errorText: string | null | undefined,
  resultText: string | null | undefined,
): ToolExecStatus {
  if (explicit) return explicit
  if (errorText) return "error"
  if (resultText) return "done"
  return "proposed"
}

export function execStatusVerb(status: ToolExecStatus, errorText?: string | null): string {
  if (status === "error") {
    const head = (errorText ?? "").trim().split(/\r?\n/)[0] ?? ""
    if (/blocked/i.test(head)) return "Blocked"
    return "Failed"
  }
  if (status === "done") return "Executed"
  if (status === "running") return "Running"
  return "Proposed"
}

export function formatExecInput(
  toolName: string,
  argumentsValue: Record<string, unknown>,
  argsFormatted?: string | null,
): { text: string; lang: string | null; copyText: string } {
  const formatted =
    argsFormatted && argsFormatted.trim()
      ? formatToolInputDisplay(toolName, argsFormatted)
      : formatToolInputDisplay(toolName, JSON.stringify(argumentsValue))
  const artifact = extractToolCode(
    toolName,
    argsFormatted && argsFormatted.trim() ? argsFormatted : argumentsValue,
  )
  const text = artifact?.code?.trim() ? artifact.code : formatted
  return {
    text,
    lang: artifact?.lang ?? null,
    copyText: text,
  }
}

export function execOutputPreview(
  resultText: string | null | undefined,
  errorText: string | null | undefined,
): string {
  const raw = (errorText ?? resultText ?? "").trim()
  if (!raw) return ""
  const firstLine = raw.split(/\r?\n/)[0] ?? raw
  return compactToolPreview(firstLine)
}

export function execErrorCode(errorText: string): string | null {
  const head = errorText.trim().split(/\r?\n/)[0] ?? ""
  const paren = head.match(/\(([A-Z][A-Z0-9_]+)\)/)
  if (paren?.[1]) return paren[1]
  if (/^[A-Z][A-Z0-9_]+$/.test(head.trim())) return head.trim()
  return null
}

export function buildExecSummary({
  toolName,
  status,
  argumentsValue,
  argsFormatted,
  resultText,
  errorText,
  durationMs,
}: {
  toolName: string
  status: ToolExecStatus
  argumentsValue: Record<string, unknown>
  argsFormatted?: string | null
  resultText?: string | null
  errorText?: string | null
  durationMs?: number | null
}): { verb: string; name: string; detail: string; duration: string | null } {
  const verb = execStatusVerb(status, errorText)
  const name = humanizeToolName(toolName)
  let detail = execOutputPreview(resultText, errorText)
  if (!detail && argsFormatted?.trim()) {
    detail =
      presentToolCallFromFormatted(toolName, argsFormatted).summary ||
      toolCallDetailPreview(toolName, argumentsValue, 80) ||
      ""
  }
  if (!detail && status === "proposed") detail = "awaiting execution"
  const duration = durationMs != null && durationMs >= 0 ? formatMs(durationMs) : null
  return { verb, name, detail, duration }
}
