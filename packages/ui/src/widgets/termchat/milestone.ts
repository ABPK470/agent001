/**
 * TermChat live milestone + history/error summaries — pure projection helpers.
 */

import {
  PRIMARY_ACTIVITY_IDS,
  buildToolNarrative,
  extractToolTarget,
  type ResponsePart,
  type ResponseProgressPart,
  type ResponseToolPart,
} from "../../lib/events/build-chat-parts"

/** Progress rows that belong in the live shimmer only — not the transcript. */
export function isOffThreadProgress(part: ResponseProgressPart): boolean {
  return (
    part.id === "direct" ||
    part.id === "thinking" ||
    part.id.startsWith("pipeline-")
  )
}

const LIVE_ACTIVITY_VERB: Record<string, string> = {
  read_file: "Reading",
  write_file: "Writing",
  replace_in_file: "Writing",
  append_file: "Writing",
  list_directory: "Listing",
  search_files: "Searching",
  search_catalog: "Searching",
  run_command: "Executing",
  query_mssql: "Executing",
  export_query_to_file: "Exporting",
  explore_mssql_schema: "Analyzing",
  inspect_definition: "Analyzing",
  discover_relationships: "Analyzing",
  profile_data: "Analyzing",
  compare_catalogs: "Analyzing",
  fetch_url: "Fetching",
  delegate: "Delegating",
  delegate_parallel: "Delegating",
  ask_user: "Asking",
  think: "Thinking",
  note: "Noting",
  get_chart_specs: "Loading chart specs",
  sync_preview: "Synchronizing",
  sync_execute: "Synchronizing",
  list_sync_definitions: "Discovering",
  resolve_sync_scope: "Resolving",
  sync_diff_scan: "Comparing",
  list_environments: "Synchronizing",
  list_attachments: "Reading attachments",
  read_attachment: "Reading attachments",
  import_attachment: "Importing attachment",
  promote_attachment: "Promoting attachment",
  record_table_verdict: "Reflecting",
}

export function liveActivityVerb(tool: string): string {
  return LIVE_ACTIVITY_VERB[tool] ?? "Working"
}

export function deriveActiveMilestoneLabel(parts: ResponsePart[]): string {
  let lastRunningTool: ResponseToolPart | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.kind === "tool" && part.row.status === "running") {
      lastRunningTool = part
      break
    }
    if (part.kind === "iteration-block" && part.hasRunning) {
      for (let j = part.tools.length - 1; j >= 0; j--) {
        if (part.tools[j]!.row.status === "running") {
          lastRunningTool = part.tools[j]!
          break
        }
      }
      if (lastRunningTool) break
    }
  }
  if (lastRunningTool) {
    return liveActivityVerb(lastRunningTool.row.tool)
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.kind === "iteration-block" && part.hasRunning) {
      return part.summary || "Working"
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.kind === "step-block" && part.hasRunning) {
      return part.detail ? `${part.title} — ${part.detail}` : part.title
    }
    if (part.kind !== "progress" || part.status !== "running") continue
    const id = part.id
    if (
      id.startsWith("step-") ||
      id.startsWith("repair-") ||
      id.startsWith("verification") ||
      id.startsWith("sql-quality-") ||
      id === "generation"
    ) {
      return part.detail ? `${part.label} — ${part.detail}` : part.label
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.kind === "progress" && part.status === "running" && PRIMARY_ACTIVITY_IDS.has(part.id)) {
      if (part.id === "direct") continue
      if (part.id === "plan" && !part.detail) continue
      return part.detail ? `${part.label} — ${part.detail}` : part.label
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!
    if (part.kind === "progress" && part.id === "thinking" && part.status === "running") {
      return "Thinking"
    }
  }

  return "Thinking…"
}

export function summarizeHistory(
  parts: Array<ResponseProgressPart | ResponseToolPart>,
): string {
  const tools = parts
    .filter((part): part is ResponseToolPart => part.kind === "tool")
    .map((part) => ({
      tool: part.row.tool,
      target: extractToolTarget(part.row.tool, part.row.details ?? "", part.row.summary ?? ""),
    }))

  if (tools.length > 0) {
    const sentence = buildToolNarrative(tools).replace(/^I\s+/, "").replace(/\.$/, "")
    if (sentence) return sentence
  }

  const lastProgress = [...parts]
    .reverse()
    .find((part): part is ResponseProgressPart => part.kind === "progress")
  return lastProgress?.label ?? "Technical flow"
}

export function summarizeRunError(error: string): { summary: string; details: string | null } {
  const lower = error.toLowerCase()
  if (
    lower.startsWith("device flow") ||
    lower.startsWith("copilot oauth token expired") ||
    lower.includes("copilot token exchange failed")
  ) {
    return {
      summary: "Authentication with Copilot failed. Please re-authorize and try again.",
      details: error,
    }
  }
  const firstLine = (error.split("\n")[0] ?? error).trim()
  if (error.length > 220 || error.includes("{")) {
    const short = firstLine.length > 180 ? `${firstLine.slice(0, 180)}…` : firstLine
    return { summary: short, details: error }
  }
  return { summary: error, details: null }
}

export function formatDeliverableBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function canElementScrollVertically(el: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false
  if (deltaY < 0) return el.scrollTop > 0
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1
  return false
}
