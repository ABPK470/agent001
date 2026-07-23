/**
 * Chat response projection — TraceEntry[] → ResponsePart[].
 *
 * Kind switches live here (lib/events), not in TermChat widgets.
 * Labels prefer the shared event catalog; CHAT_VIEW_SPEC documents nesting.
 * Leaf JSX stays in TermChat.
 */

import {
  presentToolCallFromFormatted,
  toolCallPreview,
} from "@mia/shared-types"
import type { TraceEntry } from "@mia/shared-types"
import { RunStatus } from "../../enums"
import { formatMs } from "../util"
import { isPlannerStepSuccessStatus, plannerStepEndDetail } from "./planner-step-status"
import type { ViewSpec } from "./types"

const POLISHED_FAILURE_MARKER = "\u2063pfm:\u2063"

function stripFailureMarker(text: string): string {
  return text.startsWith(POLISHED_FAILURE_MARKER)
    ? text.slice(POLISHED_FAILURE_MARKER.length)
    : text
}

function isRunActiveStatus(status: string | null | undefined): boolean {
  return (
    status === RunStatus.Pending ||
    status === RunStatus.Running ||
    status === RunStatus.Planning
  )
}

export interface ToolRow {
  id: string
  tool: string
  summary: string
  /** Wire id from the LLM tool_call — used to attach SQL-quality events. */
  toolCallId?: string | null
  // Raw JSON args from the tool-call event — kept verbatim so the
  // expanded view can show the FULL command/query/path the agent
  // dispatched (not just a truncated summary). Mirrors what Copilot
  // Chat reveals when you click into a leaf tool row.
  argsFormatted?: string
  // Tool's output text from the tool-result event (or error text from
  // tool-error). Distinct from argsFormatted so the expanded view can
  // render BOTH input and output side-by-side. Previously this slot
  // was overloaded — first set to argsFormatted, then clobbered by the
  // result — which is why expanded leaves only ever showed the output.
  details?: string
  status: "running" | "done" | "error"
}

export interface ResponseProgressPart {
  kind: "progress"
  id: string
  label: string
  status: "running" | "done" | "error"
  /** Short first-line meta (e.g. step name). Always visible. */
  detail?: string
  /**
   * Issue / waiting notes — collapsed by default. Expand to read.
   */
  body?: string
  shimmer?: boolean
}

export interface ResponseToolPart {
  kind: "tool"
  id: string
  row: ToolRow
}

// One agent-loop iteration's worth of tool calls, grouped under a single
// summary header that the user can collapse/expand. This is the Copilot-
// style "encapsulation" of a turn — multiple actions roll up into one
// short sentence describing what the iteration did, with the per-action
// detail tucked behind a chevron.
export interface ResponseIterationPart {
  kind: "iteration-block"
  id: string
  // The synthesized one-line header (e.g. "Ran python3, node -e, and node").
  // Distinct from any thinking-narrative paragraph above the block — that
  // describes the *intent*; this describes *what was done*.
  summary: string
  tools: ResponseToolPart[]
  // Whether any contained tool is still running. Used to keep the block
  // expanded by default while the iteration is in flight.
  hasRunning: boolean
}

/** Planner outline — expandable list of named steps (not engine jargon). */
export interface ResponsePlanPart {
  kind: "plan"
  id: string
  status: "running" | "done" | "error"
  stepCount: number
  steps: Array<{ name: string; type?: string }>
  /** How subagent steps run — folded into the Plan header, not a second chip. */
  executionMode?: "parallel" | "serial" | "guided" | "stop"
}

/**
 * One planned step as a parent for the tools that ran inside it.
 * Same collapsible dialect as iteration-block — hierarchy, not a flat peer list.
 */
export interface ResponseStepBlockPart {
  kind: "step-block"
  id: string
  title: string
  status: "running" | "done" | "error"
  detail?: string
  /** True when this step is a repair re-run (tools under it are the fix). */
  repair?: boolean
  /** True when the planner ran this step as a subagent_task. */
  subagent?: boolean
  tools: ResponseToolPart[]
  hasRunning: boolean
}

export interface ResponseMarkdownPart {
  kind: "markdown"
  id: string
  text: string
  streaming?: boolean
}

export interface ResponseNarrativePart {
  kind: "narrative"
  id: string
  text: string
  tone?: "neutral" | "error"
  /** status = muted system chrome (planner beats); prose = assistant voice */
  role?: "status" | "prose"
}

export interface ResponseInputPart {
  kind: "input"
  id: string
  question: string
  options?: string[]
  sensitive?: boolean
}

export interface ResponseErrorPart {
  kind: "error"
  id: string
  text: string
}

/** Coalesced sync tool progress — lives in trace above the live shimmer. */
export interface ResponseSyncProgressPart {
  kind: "sync-progress"
  id: string
  invocationId: string
  tool: string
  status: "running" | "done" | "error"
  headline: string
  detail?: string
  level?: "info" | "warn" | "error"
  sql?: {
    label: string
    connection: string
    preview: string
    rowCount?: number | null
    durationMs?: number | null
  }
  result?: string
}

export type ResponsePart =
  | ResponseProgressPart
  | ResponseToolPart
  | ResponseIterationPart
  | ResponsePlanPart
  | ResponseStepBlockPart
  | ResponseMarkdownPart
  | ResponseNarrativePart
  | ResponseInputPart
  | ResponseErrorPart
  | ResponseSyncProgressPart

const TOOL_VERB: Record<string, string> = {
  // Filesystem
  read_file: "read",
  write_file: "wrote",
  append_file: "appended to",
  replace_in_file: "edited",
  list_directory: "listed",
  search_files: "searched",
  // Shell / commands
  run_command: "ran",
  // Web
  fetch_url: "fetched",
  // Delegation / planning
  delegate: "delegated to",
  delegate_parallel: "delegated in parallel to",
  ask_user: "asked",
  think: "thought about",
  note: "noted",
  // Catalog / metadata
  search_catalog: "searched catalog for",
  compare_catalogs: "compared catalogs of",
  inspect_definition: "inspected definition of",
  discover_relationships: "mapped relationships for",
  profile_data: "profiled",
  // Database
  explore_mssql_schema: "inspected schema of",
  query_mssql: "queried",
  export_query_to_file: "exported query to",
  // Charts
  get_chart_specs: "loaded chart specs for",
  // Sync / environments
  sync_preview: "previewed sync for",
  sync_execute: "ran sync for",
  list_sync_definitions: "listed sync definitions",
  resolve_sync_scope:    "resolved sync scope for",
  sync_diff_scan: "scanned diffs for",
  list_environments: "listed environments",
  // Attachments
  list_attachments: "listed attachments",
  read_attachment: "read attachment",
  import_attachment: "imported attachment",
  promote_attachment: "promoted attachment",
  // Reflection / meta tools — normally hidden via HIDDEN_TOOLS, but if they
  // ever leak into the visible thread they should at least read cleanly
  // (instead of "used record_table_verdict something").
  record_table_verdict: "recorded a verdict for",
}

// Tools whose calls we deliberately suppress from the user-visible thread.
// These are orchestrator-internal: they run AFTER the user-facing answer
// (reflection / verdict recording) or are otherwise noise that doesn't help
// the user follow what the agent is doing. Hidden from individual tool rows,
// from iteration-block headers, and from the live shimmer label.
const HIDDEN_TOOLS = new Set<string>([
  "record_table_verdict",
])

const VERB_DEFAULT_NOUN: Record<string, string> = {
  read: "files",
  wrote: "files",
  "appended to": "a file",
  edited: "files",
  listed: "a directory",
  searched: "the codebase",
  ran: "a command",
  fetched: "a URL",
  "delegated to": "a subagent",
  "delegated in parallel to": "subagents",
  asked: "a question",
  "thought about": "the problem",
  noted: "an observation",
  "searched catalog for": "tables",
  "compared catalogs of": "two environments",
  "inspected definition of": "an object",
  "mapped relationships for": "a table",
  profiled: "a table",
  "inspected schema of": "a table",
  queried: "the database",
  "exported query to": "a file",
  "loaded chart specs for": "a dataset",
  "previewed sync for": "an environment",
  "ran sync for": "an environment",
  "listed environments": "",
  "listed attachments": "",
  "read attachment": "",
  "imported attachment": "",
  "promoted attachment": "",
  "recorded a verdict for": "a table",
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return i >= 0 ? p.slice(i + 1) : p
}

function shortCommand(c: string): string {
  const head = c.trim().split(/\s+/).slice(0, 3).join(" ")
  const display = head.length > 40 ? `${head.slice(0, 40)}…` : head
  return `\`${display}\``
}

function shortQuery(q: string): string {
  const t = q.replace(/\s+/g, " ").trim()
  return t.length > 36 ? `"${t.slice(0, 36)}…"` : `"${t}"`
}

function urlHost(u: string): string {
  try { return new URL(u).host } catch { return u.slice(0, 40) }
}

export function extractToolTarget(tool: string, argsFormatted: string, argsSummary: string): string | undefined {
  let args: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(argsFormatted) as unknown
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
  } catch (err: unknown) { console.error("[mia]", err) }

  // Args JSON path — preferred, exposes the real field names.
  if (args) {
    const displayArgs = args
    const preview = toolCallPreview(tool, displayArgs)
    if (preview) return preview
    for (const k of ["path", "filePath", "file", "filename", "filepath", "target"]) {
      const v = displayArgs[k]
      if (typeof v === "string" && v) return basename(v)
    }
    for (const k of ["paths", "files"]) {
      const v = displayArgs[k]
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return basename(v[0])
    }
    for (const k of ["command", "cmd"]) {
      const v = displayArgs[k]
      if (typeof v === "string" && v) return shortCommand(v)
    }
    for (const k of ["url", "href"]) {
      const v = displayArgs[k]
      if (typeof v === "string" && v) return urlHost(v)
    }
    for (const k of ["query", "pattern", "q", "search"]) {
      const v = displayArgs[k]
      if (typeof v === "string" && v) return shortQuery(v)
    }
    for (const k of ["agent", "agentId", "delegateTo", "to"]) {
      const v = displayArgs[k]
      if (typeof v === "string" && v) return v
    }
  }

  // Fallback — argsSummary has the form `key="value"` for single-arg tools.
  const m = argsSummary.match(/^[a-zA-Z_]+=(.+)$/)
  if (m) {
    let v = m[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (v) return v.length > 40 ? `${v.slice(0, 40)}…` : v
  }
  return undefined
}


function formatVerbPhrase(verb: string, targets: string[]): string {
  const unique: string[] = []
  for (const t of targets) {
    if (!t) continue
    if (!unique.includes(t)) unique.push(t)
  }
  if (unique.length === 0) {
    // Unknown verb with no extractable target — humanize cleanly
    // (drop the placeholder "something" that used to appear here).
    return VERB_DEFAULT_NOUN[verb] ? `${verb} ${VERB_DEFAULT_NOUN[verb]}` : verb
  }
  if (unique.length === 1) return `${verb} ${unique[0]}`
  if (unique.length === 2) return `${verb} ${unique[0]} and ${unique[1]}`
  if (unique.length === 3) return `${verb} ${unique[0]}, ${unique[1]} and ${unique[2]}`
  return `${verb} ${unique[0]}, ${unique[1]} and ${unique.length - 2} more`
}

export function buildToolNarrative(tools: Array<{ tool: string; target?: string }>): string {
  if (tools.length === 0) return ""
  // Group by verb, preserving first-seen order so the sentence reads in
  // chronological order of the agent's actions.
  const order: string[] = []
  const grouped = new Map<string, string[]>()
  for (const t of tools) {
    const verb = TOOL_VERB[t.tool] ?? `used ${t.tool}`
    if (!grouped.has(verb)) {
      grouped.set(verb, [])
      order.push(verb)
    }
    if (t.target) grouped.get(verb)!.push(t.target)
  }
  const phrases = order.map((verb) => formatVerbPhrase(verb, grouped.get(verb) ?? []))
  return `I ${joinLabels(phrases)}.`
}

// Header text for a collapsed iteration block. Distinct phrasing from
// the prose narrative paragraphs so the user can tell them apart at a
// glance: paragraphs read like the assistant talking ("I'll check the
// build first, then..."); the block header is a terse declarative
// summary of what was actually done ("Ran python3, node -e and node").
export function buildIterationHeader(tools: Array<{ tool: string; target?: string }>): string {
  if (tools.length === 0) return "Worked on it"
  const sentence = buildToolNarrative(tools)
  // Strip leading "I " and trailing period; capitalize the verb so the
  // header reads as a label, not a sentence.
  const stripped = sentence.replace(/^I\s+/, "").replace(/\.$/, "")
  return stripped.length > 0
    ? stripped[0].toUpperCase() + stripped.slice(1)
    : "Worked on it"
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return ""
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

function patchToolStatus(
  parts: ResponsePart[],
  invocationId: string,
  status: "done" | "error",
  text?: string,
): ResponsePart[] {
  return parts.map((part) => {
    if (part.kind === "tool" && part.id === invocationId) {
      return { ...part, row: { ...part.row, status, details: text || part.row.details } }
    }
    if (part.kind === "iteration-block" || part.kind === "step-block") {
      let changed = false
      const tools = part.tools.map((p) => {
        if (p.id !== invocationId) return p
        changed = true
        return { ...p, row: { ...p.row, status, details: text || p.row.details } }
      })
      if (!changed) return part
      return {
        ...part,
        tools,
        hasRunning: tools.some((p) => p.row.status === "running"),
      }
    }
    return part
  })
}

/** Attach SQL-gate outcome onto the matching tool row (by toolCallId). */
function annotateToolSqlQuality(
  parts: ResponsePart[],
  toolCallId: string,
  status: "done" | "error",
  message: string,
): ResponsePart[] {
  function patchRow(row: ToolRow): ToolRow | null {
    if (row.toolCallId !== toolCallId && row.id !== toolCallId) return null
    return {
      ...row,
      status: status === "error" ? "error" : row.status === "running" ? "done" : row.status,
      details: message || row.details,
    }
  }

  return parts.map((part) => {
    if (part.kind === "tool") {
      const next = patchRow(part.row)
      return next ? { ...part, row: next } : part
    }
    if (part.kind === "iteration-block" || part.kind === "step-block") {
      let changed = false
      const tools = part.tools.map((p) => {
        const next = patchRow(p.row)
        if (!next) return p
        changed = true
        return { ...p, row: next }
      })
      if (!changed) return part
      return {
        ...part,
        tools,
        hasRunning: tools.some((t) => t.row.status === "running"),
      }
    }
    return part
  })
}

function upsertProgressPart(parts: ResponsePart[], nextPart: ResponseProgressPart): ResponsePart[] {
  const index = parts.findIndex((part) => part.kind === "progress" && part.id === nextPart.id)
  if (index < 0) return parts.concat(nextPart)
  const next = [...parts]
  next[index] = { ...next[index], ...nextPart }
  return next
}

function setActivityPart(
  parts: ResponsePart[],
  id: string,
  label: string,
  status: "running" | "done" | "error",
  detail?: string,
  shimmer?: boolean,
  body?: string,
): ResponsePart[] {
  return upsertProgressPart(parts, {
    kind: "progress",
    id,
    label,
    status,
    detail,
    shimmer,
    ...(body ? { body } : {}),
  })
}

export const PRIMARY_ACTIVITY_IDS = new Set([
  "thinking",
  "plan",
  "direct",
  "generation",
  "verification",
])

function settlePrimaryActivities(
  parts: ResponsePart[],
  nextActiveId: string,
): ResponsePart[] {
  return parts.map((part) => {
    if (part.kind !== "progress") return part
    if (!PRIMARY_ACTIVITY_IDS.has(part.id)) return part
    if (part.id === nextActiveId) return part
    if (part.status !== "running") return part
    return { ...part, status: "done", shimmer: false }
  })
}

function compactToolPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export { compactToolPreview }

// Build the inline pill summary (e.g. `path="/long/file/path.css"`) from
// the raw argsFormatted JSON. Always preferred over the persisted
// `argsSummary`, which historically was sliced to 60 chars server-side.
// Single-arg → `key="value"`. Multi-arg → `N args`.
function buildArgsSummary(tool: string, argsFormatted: string): string {
  return presentToolCallFromFormatted(tool, argsFormatted).summary
}

export function humanizeStepName(stepName: string): string {
  return stepName.replace(/_/g, " ")
}

/** Plan step title — Subagent / Repair are first-class, not hidden chrome. */
function stepBlockTitle(opts: {
  stepName: string
  stepType?: string
  repair?: boolean
}): string {
  const name = humanizeStepName(opts.stepName)
  if (opts.repair) return `Repair · ${name}`
  if (opts.stepType === "subagent_task") return `Subagent · ${name}`
  return name
}

function truncateStepDetail(text: string, max = 88): string {
  const t = text.trim().replace(/\s+/g, " ")
  if (!t) return t
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Terse tool beat for a step header — same dialect as live subagent tools. */
function stepToolsDetail(tools: ResponseToolPart[]): string {
  return tools
    .slice(0, 3)
    .map((t) => {
      const name = t.row.tool.replace(/_/g, " ")
      const target = extractToolTarget(t.row.tool, t.row.argsFormatted ?? "", t.row.summary)
      return target ? `${name} ${target}` : name
    })
    .join(" · ")
}

function hasHiddenToolDetails(summary: string, details?: string): boolean {
  const full = (details ?? "").trim()
  if (!full) return false
  const compactFull = compactToolPreview(full)
  return compactFull !== summary || full.includes("\n") || compactFull.length > 96
}
void hasHiddenToolDetails

// Reduce the LLM's raw reasoning text to a single short conversational
// sentence. Strips markdown headings/bullets/code fences and keeps only
// the first non-trivial line, capped to ~180 chars so each iteration
// reads as a chat-bubble update rather than a wall of thoughts.
function summarizeThinking(raw: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[*\-•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length < 4) continue
    const sentenceMatch = line.match(/^(.+?[.!?])(\s|$)/)
    const sentence = (sentenceMatch ? sentenceMatch[1] : line).trim()
    if (sentence.length < 4) continue
    return sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence
  }
  return ""
}
void summarizeThinking

function summarizeSqlQualityEntry(entry: Extract<TraceEntry, { kind: "planner-sql-quality" }>): string {
  const notes: string[] = []
  if (entry.validationCode) {
    const label =
      entry.validationCode === "read_only_tool" ? "tool read-only" : entry.validationCode
    notes.push(`blocked by ${label}`)
  }
  if (entry.missingPersistedMirrorCandidates.length > 0) {
    notes.push(`missed persisted mirror for ${entry.missingPersistedMirrorCandidates.join(", ")}`)
  }
  const overusedRefs = entry.largeObjectRefs.filter((ref) => ref.count > 2)
  if (overusedRefs.length > 0) {
    notes.push(overusedRefs.map((ref) => `${ref.name} referenced ${ref.count}x`).join(", "))
  }
  if (entry.tempScalarSubqueryCount > 0) notes.push(`temp scalar subqueries ${entry.tempScalarSubqueryCount}`)
  if (entry.malformedTempSuffixes.length > 0) notes.push(`bad temp suffix ${entry.malformedTempSuffixes.join(", ")}`)
  if (entry.missingTempCreations.length > 0) notes.push(`missing temp create ${entry.missingTempCreations.join(", ")}`)
  if (notes.length === 0) return entry.phase === "executed" ? "checked" : entry.phase
  return notes.join(" · ")
}

// Strip the noisy driver/wrapper prefixes off a raw SQL Server error so the
// chat line reads as the actual server message, not a stack-frame label.
// Caps length so a giant message (multi-line plan / parser dump) doesn't
// dominate the conversation — full error remains on the tool-result row.
function cleanSqlError(raw: string | null | undefined): string {
  if (!raw) return ""
  let s = raw.trim()
  // Drop common driver prefixes like "RequestError: ", "Error: ",
  // "[Microsoft][ODBC Driver 17 for SQL Server][SQL Server]"
  s = s.replace(/^(RequestError|Error|TypeError|MssqlError):\s*/i, "")
  s = s.replace(/^\[[^\]]+\](\[[^\]]+\])*\s*/g, "")
  // Collapse whitespace and keep first line — server returns the salient
  // line first; following lines are usually "Procedure …, Line …".
  const firstLine = s.split(/\r?\n/)[0].trim()
  const result = firstLine.length > 0 ? firstLine : s
  return result.length > 240 ? result.slice(0, 240) + "…" : result
}

// Human-readable narrative for an SQL-quality trace event. Returns "" to
// suppress narration entirely (e.g. clean `executed` with no notes).
//
// Phases (see `packages/agent/src/tools/mssql/tools.ts`):
//   - `blocked`  → our own validator refused to send the SQL.
//   - `executed` → sent and returned rows without server error.
//   - `failed`   → sent, SQL Server itself returned an error at runtime.
function describeSqlQualityForChat(
  entry: Extract<TraceEntry, { kind: "planner-sql-quality" }>,
): { text: string; tone: "neutral" | "error" } {
  const notes = summarizeSqlQualityEntry(entry)
  if (entry.phase === "blocked") {
    const reason = entry.validationCode
      ? (entry.validationCode === "read_only_tool"
          ? "tool read-only"
          : entry.validationCode)
      : notes !== "blocked"
        ? notes
        : "validator refused the query"
    const hint =
      entry.validationCode === "read_only_tool"
        ? "this tool only allows SELECT/WITH/#temp."
        : "query needs a tighter filter."
    return {
      text: `Blocked before send (${reason}) — ${hint}`,
      tone: "error",
    }
  }
  if (entry.phase === "failed") {
    const err = cleanSqlError(entry.error)
    return {
      text: err
        ? `SQL Server rejected my query: ${err}`
        : "SQL Server rejected my query (no error message returned).",
      tone: "error",
    }
  }
  // executed
  if (notes && notes !== "checked") {
    return { text: `Query ran. Quality notes: ${notes}.`, tone: "neutral" }
  }
  return { text: "", tone: "neutral" }
}

export function buildResponseParts(
  trace: TraceEntry[],
  runStatus: string,
  liveStreamingAnswer: string,
  finalAnswer: string | null,
  finalError: string | null,
  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null,
  runId: string,
): ResponsePart[] {
  let parts: ResponsePart[] = []
  const runningSteps = new Map<string, string>()
  /** Open planner step — tools nest here instead of floating as peers. */
  let openStepId: string | null = null
  /**
   * Repair is control-plane (plan / retry / escalate) + the step that
   * re-runs. Chat shows only the re-run step — titled "Repair · …" —
   * with tools nested under it. Empty "Repair" progress peers hide the work.
   */
  let pendingRepair: { attempt: number; steps: Set<string> } | null = null
  // Track tool calls used since the last narrative/iteration boundary.
  // We carry the tool name AND a short target (file basename, command,
  // URL, etc.) so the synthesized narrative reads like
  // "I read store.ts and TermChat.tsx, then ran `npm run build`."
  // instead of a generic "I read files."
  // Per-iteration tool grouping. We collect ToolPart objects emitted
  // during the current agent-loop iteration and, when we hit the next
  // `iteration` trace boundary (or the final pre-answer flush), we
  // REPLACE those individual tool parts in `parts` with one
  // ResponseIterationPart that carries them as children + a synthesized
  // header. That gives the user the Copilot-style collapsible
  // "encapsulation" of an agent turn while preserving full per-call
  // detail behind the chevron.
  let pendingTools: ResponseToolPart[] = []
  let pendingTargets: Array<{ tool: string; target?: string }> = []
  let blockSeq = 0

  const flushIterationBlock = (boundaryIndex: number) => {
    if (pendingTools.length === 0) return
    // Strip the in-flight tool parts back out of `parts` (they were pushed
    // there individually so the live UI could show them as they happened).
    // We replace them with one block at the same position as the first.
    const firstId = pendingTools[0].id
    const firstIndex = parts.findIndex((p) => p.kind === "tool" && p.id === firstId)
    if (firstIndex >= 0) {
      // Drop every contiguous tool part starting at firstIndex that is
      // part of this iteration. We match by id-set rather than slicing
      // blindly so we don't accidentally consume a later iteration's
      // tools (defensive — shouldn't normally happen).
      const idSet = new Set(pendingTools.map((p) => p.id))
      const keep: ResponsePart[] = []
      for (let i = 0; i < parts.length; i++) {
        if (i === firstIndex) continue
        const p = parts[i]
        if (p.kind === "tool" && idSet.has(p.id)) continue
        keep.push(p)
      }
      const block: ResponseIterationPart = {
        kind: "iteration-block",
        id: `iter-block-${boundaryIndex}-${blockSeq++}`,
        summary: buildIterationHeader(pendingTargets),
        tools: pendingTools,
        hasRunning: pendingTools.some((p) => p.row.status === "running"),
      }
      keep.splice(firstIndex, 0, block)
      parts = keep
    }
    pendingTools = []
    pendingTargets = []
  }

  for (let index = 0; index < trace.length; index++) {
    const entry = trace[index]
    switch (entry.kind) {
      case "iteration": {
        // Boundary between agent-loop iterations. Roll up the tool calls
        // collected since the previous boundary into ONE collapsible
        // ResponseIterationPart — that's the Copilot-style "this turn
        // did X" encapsulation the user expects to be able to fold.
        flushIterationBlock(index)
        break
      }
      case "thinking": {
        // Pre-tool narration is internal reasoning — never render it as chat
        // prose. Showing it here duplicated text that briefly appeared in the
        // answer bubble before tool calls and made the thread feel corrupted.
        break
      }
      case "planning_preflight":
        parts = settlePrimaryActivities(parts, "plan")
        parts = setActivityPart(parts, "plan", "Preparing plan…", "running", undefined, true)
        break
      case "planner-decision": {
        const isDirect = !entry.shouldPlan || entry.route === "direct"
        const activityId = isDirect ? "direct" : "plan"
        parts = settlePrimaryActivities(parts, activityId)
        parts = setActivityPart(
          parts,
          activityId,
          isDirect ? "Working…" : "Preparing plan…",
          "running",
          undefined,
          true,
        )
        break
      }
      case "planner-delegation-decision": {
        // CHAT_VIEW_SPEC omits delegation family — fold mode into the plan
        // outline on one line. Never reopen a bare "Plan" progress chip.
        const mode = entry.executionMode
        const executionMode =
          mode === "parallel" || mode === "serial" || mode === "guided" || mode === "stop"
            ? mode
            : entry.shouldDelegate
              ? "parallel"
              : "serial"
        let folded = false
        parts = parts.map((part) => {
          if (part.kind !== "plan") return part
          folded = true
          return {
            ...part,
            executionMode,
            status: mode === "stop" ? ("error" as const) : part.status,
          }
        })
        if (!folded && mode === "stop") {
          parts = parts.concat({
            kind: "narrative",
            id: `delegation-stop-${index}`,
            text: "Subagents blocked",
            tone: "error",
            role: "status",
          })
        }
        break
      }
      case "planner-generating":
        parts = settlePrimaryActivities(parts, "plan")
        parts = setActivityPart(parts, "plan", "Generating plan…", "running", undefined, true)
        break
      case "planner-plan-generated": {
        // Replace the generating chip with an expandable plan outline.
        parts = parts.filter((p) => !(p.kind === "progress" && p.id === "plan"))
        parts = parts.concat({
          kind: "plan",
          id: "plan",
          status: "done",
          stepCount: entry.stepCount,
          steps: entry.steps.map((s) => ({ name: s.name, type: s.type })),
        })
        break
      }
      case "planner-pipeline-start":
      case "planner-pipeline-end":
        // Pipeline is orchestrator jargon (retry loop) — steps are the parent units.
        break
      case "planner-step-start": {
        flushIterationBlock(index)
        const activityId = `step-${entry.stepName}-${index}`
        runningSteps.set(entry.stepName, activityId)
        openStepId = activityId
        const isRepair = !!pendingRepair?.steps.has(entry.stepName)
        const isSubagent = entry.stepType === "subagent_task"
        parts = parts.concat({
          kind: "step-block",
          id: activityId,
          title: stepBlockTitle({
            stepName: entry.stepName,
            stepType: entry.stepType,
            repair: isRepair,
          }),
          status: "running",
          detail: isRepair && pendingRepair ? `attempt ${pendingRepair.attempt}` : undefined,
          repair: isRepair || undefined,
          subagent: isSubagent || undefined,
          tools: [],
          hasRunning: true,
        })
        break
      }
      case "planner-step-end": {
        const activityId = runningSteps.get(entry.stepName) ?? `step-${entry.stepName}-${index}`
        const ok = isPlannerStepSuccessStatus(entry.status)
        const endDetail = plannerStepEndDetail({
          status: entry.status,
          error: entry.error,
          durationMs: entry.durationMs,
          formatMs,
        })
        // Process gaps (verify fail → repair) are normal agent work — settle
        // as done chrome with the reason in detail, never alarm-red "error".
        // Pipeline success is "completed"; older traces may use pass/success.
        // When nested tools exist (deterministic I/O), keep the tool label on
        // the header — same terse dialect as live subagent tool beats.
        parts = parts.map((part) => {
          if (part.kind !== "step-block" || part.id !== activityId) return part
          const toolLabel =
            ok && part.tools.length > 0 ? stepToolsDetail(part.tools) : undefined
          const detail =
            toolLabel && endDetail
              ? `${toolLabel} · ${endDetail}`
              : (toolLabel ?? endDetail)
          return {
            ...part,
            status: "done" as const,
            detail,
            hasRunning: part.tools.some((t) => t.row.status === "running"),
          }
        })
        if (ok && pendingRepair?.steps.has(entry.stepName)) {
          pendingRepair.steps.delete(entry.stepName)
          if (pendingRepair.steps.size === 0) pendingRepair = null
        }
        runningSteps.delete(entry.stepName)
        if (openStepId === activityId) openStepId = null
        break
      }
      case "planner-delegation-start": {
        let activityId = runningSteps.get(entry.stepName)
        const goalDetail = truncateStepDetail(entry.goal)
        if (!activityId) {
          flushIterationBlock(index)
          activityId = `step-${entry.stepName}-${index}`
          runningSteps.set(entry.stepName, activityId)
          openStepId = activityId
          const isRepair = !!pendingRepair?.steps.has(entry.stepName)
          parts = parts.concat({
            kind: "step-block",
            id: activityId,
            title: stepBlockTitle({
              stepName: entry.stepName,
              stepType: "subagent_task",
              repair: isRepair,
            }),
            status: "running",
            detail:
              isRepair && pendingRepair
                ? `attempt ${pendingRepair.attempt}`
                : goalDetail || "working",
            repair: isRepair || undefined,
            subagent: true,
            tools: [],
            hasRunning: true,
          })
        } else {
          parts = parts.map((part) =>
            part.kind === "step-block" && part.id === activityId
              ? {
                  ...part,
                  status: "running" as const,
                  // Goal is the work description — not tool allowlists / iteration chrome.
                  detail:
                    part.repair && pendingRepair
                      ? `attempt ${pendingRepair.attempt}`
                      : goalDetail || part.detail,
                  subagent: part.subagent || true,
                  hasRunning: true,
                }
              : part,
          )
          openStepId = activityId
        }
        break
      }
      case "planner-delegation-iteration": {
        // Per-subagent live beat — tagged with stepName (safe under parallel).
        const activityId = runningSteps.get(entry.stepName)
        if (!activityId) break
        const liveTools = Array.isArray(entry.toolNames) ? entry.toolNames.filter(Boolean) : []
        const liveDetail =
          liveTools.length > 0
            ? liveTools
                .slice(0, 3)
                .map((name) => String(name).replace(/_/g, " "))
                .join(" · ")
            : undefined
        parts = parts.map((part) =>
          part.kind === "step-block" && part.id === activityId
            ? {
                ...part,
                status: "running" as const,
                hasRunning: true,
                ...(liveDetail ? { detail: liveDetail } : {}),
              }
            : part,
        )
        break
      }
      case "planner-delegation-end": {
        const activityId = runningSteps.get(entry.stepName)
        if (!activityId) break
        parts = parts.map((part) => {
          if (part.kind !== "step-block" || part.id !== activityId) return part
          if (part.status === "done") return part
          return {
            ...part,
            // Delegation gaps are process — settle neutrally; detail keeps the reason.
            status: "done" as const,
            detail: entry.status === "done" ? part.detail : (entry.error ?? part.detail),
            hasRunning: part.tools.some((t) => t.row.status === "running"),
          }
        })
        break
      }
      case "planner-verification": {
        parts = settlePrimaryActivities(parts, "verification")
        const failed = entry.steps.filter((s) => s.outcome !== "pass")
        // Visible line: which step needs work. Issue text stays collapsed —
        // readers expand only when they want the waiting/mismatch details.
        const verifyWhat =
          entry.overall === "pass"
            ? undefined
            : failed[0]
              ? humanizeStepName(failed[0].stepName)
              : entry.overall
        const verifyBody =
          entry.overall === "pass"
            ? undefined
            : failed
                .flatMap((s) => {
                  const name = humanizeStepName(s.stepName)
                  if (s.issues.length === 0) return []
                  return s.issues.map((issue) => `${name}: ${issue}`)
                })
                .join("\n") || undefined
        // Pass and "found gaps" are both settled checks — never alarm-red.
        parts = setActivityPart(
          parts,
          `verification-${index}`,
          entry.overall === "pass" ? "Checked work" : "Check · needs work",
          entry.overall === "pass" || entry.overall === "fail" ? "done" : "running",
          verifyWhat,
          entry.overall !== "pass" && entry.overall !== "fail",
          verifyBody,
        )
        break
      }
      case "planner-repair-plan": {
        // Remember which steps will re-run — the next matching step-start
        // becomes "Repair · …" with tools nested. No empty Repair peer.
        const repairSteps = new Set<string>(
          (entry.tasks.length > 0
            ? entry.tasks.map((t) => t.stepName)
            : entry.rerunOrder ?? []
          ).filter(Boolean),
        )
        pendingRepair = { attempt: entry.attempt, steps: repairSteps }
        break
      }
      case "planner-retry": {
        // Same control-plane as repair-plan: update attempt / targets only.
        let names: string[] = []
        if (Array.isArray(entry.rerunOrder) && entry.rerunOrder.length > 0) {
          names = entry.rerunOrder.filter((s): s is string => typeof s === "string" && s.length > 0)
        } else if (pendingRepair) {
          names = [...pendingRepair.steps]
        }
        if (names.length > 0) {
          pendingRepair = { attempt: entry.attempt, steps: new Set(names) }
        }
        break
      }
      case "planner-escalation": {
        // revise / retry → next step re-run is the repair body (already pending).
        // escalate (gave up) → surface once as error prose, not a Repair chip.
        const attempt = entry.attempt
        if (entry.action === "escalate") {
          parts = parts.concat({
            kind: "narrative",
            id: `escalation-${index}`,
            text: entry.reason
              ? `Could not finish after repair attempt ${attempt}: ${entry.reason.replace(/_/g, " ")}`
              : `Could not finish after repair attempt ${attempt}`,
            tone: "error",
            role: "status",
          })
        }
        break
      }
      case "planner-sql-quality": {
        // Real gate on query_mssql (validator / server), NOT an LLM review
        // of every tool. Clean passes stay silent — the tool result is enough.
        // Blocked/failed annotate the matching tool so cause stays on that row.
        const { text: narrativeText } = describeSqlQualityForChat(entry)
        if (entry.phase === "executed" && !narrativeText) {
          break
        }
        const status: "done" | "error" =
          entry.phase === "blocked" || entry.phase === "failed" || !!entry.validationCode
            ? "error"
            : "done"
        const message =
          narrativeText ||
          (entry.phase === "failed"
            ? `SQL failed: ${cleanSqlError(entry.error) || "server error"}`
            : entry.phase === "blocked"
              ? `Blocked before send: ${
                  entry.validationCode === "read_only_tool"
                    ? "tool read-only"
                    : (entry.validationCode ?? summarizeSqlQualityEntry(entry))
                }`
              : summarizeSqlQualityEntry(entry))
        parts = annotateToolSqlQuality(parts, entry.toolCallId, status, message)
        break
      }
      case "direct_loop_fallback":
        parts = settlePrimaryActivities(parts, "direct")
        parts = setActivityPart(parts, "direct", "Direct", "running", undefined, true)
        break
      case "sync-progress":
        parts = parts.concat({
          kind: "sync-progress",
          id: `sync-progress-${entry.invocationId}`,
          invocationId: entry.invocationId,
          tool: entry.tool,
          status: entry.status,
          headline: entry.headline,
          detail: entry.detail,
          level: entry.level,
          sql: entry.sql,
          result: entry.result
        })
        break
      case "tool-call": {
        // Hide orchestrator-internal / meta tools from the visible thread.
        // They don't help the user follow what's happening and produce
        // confusing headers like "Used record_table_verdict something".
        if (HIDDEN_TOOLS.has(entry.tool)) break
        // Once tools start, the bare "Thinking" indicator is no longer
        // truthful — the real activity is the tool call below. Other
        // primary phases (Plan/Generation/Verification) terminate via
        // their own events.
        parts = parts.map((part) =>
          part.kind === "progress" && part.id === "thinking" && part.status === "running"
            ? { ...part, status: "done", shimmer: false }
            : part,
        )
        const toolPart: ResponseToolPart = {
          kind: "tool",
          id: entry.invocationId,
          row: {
            id: entry.invocationId,
            tool: entry.tool,
            toolCallId: entry.toolCallId ?? null,
            // Recompute from argsFormatted so historically-persisted
            // traces (which had argsSummary sliced to 60 chars) also
            // render the full single-arg value. Fall back to the
            // persisted argsSummary only if JSON parsing fails.
            summary: buildArgsSummary(entry.tool, entry.argsFormatted) || entry.argsSummary || compactToolPreview(entry.argsFormatted),
            argsFormatted: entry.argsFormatted,
            // details holds the OUTPUT only — populated on tool-result /
            // tool-error. argsFormatted holds the INPUT separately.
            details: undefined,
            status: "running",
          },
        }
        // Prefer planner stepName (parallel-safe). Fall back to openStepId
        // for serial parent tools that never got a step stamp.
        const nestStepId =
          (entry.stepName ? runningSteps.get(entry.stepName) : undefined) ?? openStepId
        if (nestStepId) {
          parts = parts.map((part) => {
            if (part.kind !== "step-block" || part.id !== nestStepId) return part
            const tools = [...part.tools, toolPart]
            return {
              ...part,
              tools,
              hasRunning: true,
              status: "running" as const,
              detail: stepToolsDetail(tools) || part.detail,
            }
          })
          break
        }
        pendingTools.push(toolPart)
        pendingTargets.push({
          tool: entry.tool,
          target: extractToolTarget(entry.tool, entry.argsFormatted, entry.argsSummary),
        })
        parts.push(toolPart)
        break
      }
      case "tool-result": {
        if (!entry.invocationId) break
        // No HIDDEN_TOOLS check needed here: tool-result doesn't carry
        // the tool name, and patchToolStatus is a no-op for invocation
        // ids we never pushed (because tool-call was filtered out).
        parts = patchToolStatus(parts, entry.invocationId, "done", entry.text)
        // Keep pendingTools mirror in sync so the next flush sees the
        // updated status (and hasRunning flips correctly).
        pendingTools = pendingTools.map((p) =>
          p.id === entry.invocationId
            ? { ...p, row: { ...p.row, status: "done", details: entry.text || p.row.details } }
            : p,
        )
        break
      }
      case "tool-error": {
        if (!entry.invocationId) break
        // Prefer an earlier SQL-gate annotation over the raw blocked string.
        parts = parts.map((part) => {
          if (part.kind === "tool" && part.id === entry.invocationId) {
            return {
              ...part,
              row: {
                ...part.row,
                status: "error",
                details: part.row.details || entry.text || part.row.details,
              },
            }
          }
          if (part.kind === "iteration-block" || part.kind === "step-block") {
            let changed = false
            const tools = part.tools.map((p) => {
              if (p.id !== entry.invocationId) return p
              changed = true
              return {
                ...p,
                row: {
                  ...p.row,
                  status: "error" as const,
                  details: p.row.details || entry.text || p.row.details,
                },
              }
            })
            if (!changed) return part
            return {
              ...part,
              tools,
              hasRunning: tools.some((t) => t.row.status === "running"),
            }
          }
          return part
        })
        pendingTools = pendingTools.map((p) =>
          p.id === entry.invocationId
            ? {
                ...p,
                row: {
                  ...p.row,
                  status: "error",
                  details: p.row.details || entry.text || p.row.details,
                },
              }
            : p,
        )
        break
      }
      case "user-input-request":
        parts.push({ kind: "input", id: `input-${index}`, question: entry.question, options: entry.options, sensitive: entry.sensitive })
        break
      case "user-input-response":
        // Once the user has answered, the prompt card has served its
        // purpose — collapse it so the conversation flows on instead of
        // leaving a stale active-looking input behind the agent's reply.
        parts = parts.filter((part) => part.kind !== "input")
        break
      case "error":
        if (entry.text === "Run cancelled by user") break
        if (finalError && entry.text === finalError) break
        parts.push({ kind: "error", id: `error-${index}`, text: entry.text })
        break
      default:
        break
    }
  }

  if (pendingInput?.runId === runId && !parts.some((part) => part.kind === "input")) {
    parts.push({ kind: "input", id: `input-live-${runId}`, question: pendingInput.question, options: pendingInput.options, sensitive: pendingInput.sensitive })
  }

  // Final flush so any tool calls that arrived after the last iteration
  // boundary still get encapsulated under one collapsible header before
  // the answer renders.
  flushIterationBlock(trace.length)

  // We use a STABLE id (`answer-${runId}`) for both the live and final
  // answer so the TypewriterAnswer component instance is preserved across
  // the run-active → run-completed transition. That keeps its internal
  // reveal cursor — the user sees the typewriter continue smoothly into
  // the final text instead of snapping it in at completion.
  if (liveStreamingAnswer) {
    // Mirror the live token buffer directly — the SSE pipeline already
    // delivers incremental chunks; gating on sentence boundaries made the
    // UI look frozen then dump whole paragraphs at once.
    const display = stripFailureMarker(liveStreamingAnswer)
    if (display) {
      parts = parts.map((part) =>
        part.kind === "progress" && part.status === "running" && PRIMARY_ACTIVITY_IDS.has(part.id)
          ? { ...part, status: "done", shimmer: false }
          : part,
      )
      parts.push({ kind: "markdown", id: `answer-${runId}`, text: display, streaming: true })
    }
  } else if (finalAnswer) {
    // Pass streaming=true if the run is still active (rare race: completed
    // but render hasn't observed it yet), false otherwise. TypewriterAnswer
    // will continue revealing whatever portion isn't yet on screen and
    // then hand off to SmartAnswer for full markdown rendering.
    const stillStreaming = isRunActiveStatus(runStatus)
    parts.push({ kind: "markdown", id: `answer-${runId}`, text: stripFailureMarker(finalAnswer), streaming: stillStreaming })
  }

  if (!isRunActiveStatus(runStatus)) {
    const terminalStatus: "done" | "error" = runStatus === RunStatus.Completed ? "done" : "error"
    parts = parts.map((part) => {
      if (part.kind === "progress" && part.status === "running") {
        return { ...part, status: terminalStatus, shimmer: false }
      }
      if (part.kind === "tool" && part.row.status === "running") {
        return { ...part, row: { ...part.row, status: terminalStatus } }
      }
      if (part.kind === "iteration-block" && part.hasRunning) {
        // The block was sealed at an iteration boundary while at least
        // one tool was still in flight. The run has now ended, so any
        // child still marked running is implicitly settled to the run's
        // terminal status — and the block itself must stop shimmering.
        const tools = part.tools.map((p) =>
          p.row.status === "running"
            ? { ...p, row: { ...p.row, status: terminalStatus } }
            : p,
        )
        return { ...part, tools, hasRunning: false }
      }
      if (part.kind === "step-block" && (part.hasRunning || part.status === "running")) {
        const tools = part.tools.map((p) =>
          p.row.status === "running"
            ? { ...p, row: { ...p.row, status: terminalStatus } }
            : p,
        )
        return {
          ...part,
          tools,
          hasRunning: false,
          status: part.status === "running" ? terminalStatus : part.status,
        }
      }
      if (part.kind === "plan" && part.status === "running") {
        return { ...part, status: terminalStatus }
      }
      return part
    })
  }

  return parts
}


/** Chat ViewSpec — nest/omit dialect for TermChat. */
export const CHAT_VIEW_SPEC: ViewSpec = {
  id: "chat",
  excludeTypes: [
    "thinking",
    "system-prompt",
    "tools-resolved",
    "llm-request",
    "llm-response",
    "answer.chunk",
    "planner-pipeline-start",
    "planner-pipeline-end",
  ],
  excludeFamilies: ["telemetry"],
  roleByFamily: {
    plan: "scope",
    step: "scope",
    call: "omit",
    work: "leaf",
    verify: "leaf",
    repair: "omit",
    input: "leaf",
    answer: "leaf",
    error: "leaf",
    sync: "leaf",
    delegation: "omit",
  },
  nest: [
    { parentFamily: "step", childFamilies: ["work", "input"] },
  ],
  terminalTypes: ["planner-step-end", "planner-delegation-end"],
  foldDefault: "latest",
}
