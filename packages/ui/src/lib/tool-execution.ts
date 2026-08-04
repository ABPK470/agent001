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

/** Copilot-style short past-tense verb for chat tool rows. */
export function chatToolVerb(
  toolName: string,
  status: ToolExecStatus,
  errorText?: string | null,
): string {
  if (status === "error") {
    const head = (errorText ?? "").trim().split(/\r?\n/)[0] ?? ""
    if (/blocked/i.test(head)) return "Blocked"
    return "Failed"
  }
  if (status === "running") return "Running"
  if (status === "proposed") return "Proposed"
  switch (toolName) {
    case "run_command":
      return "Ran"
    case "query_mssql":
      return "Queried"
    case "write_file":
    case "append_file":
      return "Wrote"
    case "read_file":
    case "read_attachment":
      return "Read"
    case "list_directory":
    case "list_dir":
    case "list_environments":
    case "list_sync_definitions":
    case "list_attachments":
      return "Listed"
    case "replace_in_file":
      return "Edited"
    case "search_files":
    case "search_catalog":
      return "Searched"
    case "ask_user":
      return "Asked"
    case "fetch_url":
      return "Fetched"
    case "sync_preview":
      return "Previewed"
    case "sync_execute":
      return "Synced"
    case "sync_diff_scan":
      return "Scanned"
    case "resolve_sync_scope":
      return "Resolved"
    case "get_chart_specs":
      return "Loaded"
    case "delegate":
      return "Delegated"
    default:
      return "Used"
  }
}

/** Truncated mono pill text for the collapsed chat summary. */
export function chatToolPillText(
  inputText: string,
  fallbackSummary?: string | null,
  max = 56,
): string {
  const raw = (inputText || fallbackSummary || "").replace(/\s+/g, " ").trim()
  if (!raw) return ""
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
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

/** Empty JSON / null displays are not real tool inputs — omit from expand body. */
export function isEmptyToolInputDisplay(text: string): boolean {
  const t = text.trim()
  return !t || t === "{}" || t === "null" || t === "[]"
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
  const raw = (artifact?.code?.trim() ? artifact.code : formatted).trim()
  // Never surface bare `{}` as the command — no-arg tools have no input body.
  const text = isEmptyToolInputDisplay(raw) ? "" : raw
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
  const colonCode = head.match(/:\s*([A-Z][A-Z0-9_]+)\s*$/)
  if (colonCode?.[1]) return colonCode[1]
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
  // Keep wire name (snake_case) — humanized + uppercase was unreadable in the inspector.
  const name = toolName
  let detail = ""
  if (status === "error" && errorText) {
    detail = execErrorCode(errorText) || execOutputPreview(null, errorText)
  } else {
    detail = execOutputPreview(resultText, errorText)
  }
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
