/**
 * TermChat — GitHub-style agent chat.
 *
 * Design: tokenized neutral palette (theme-driven via index.css), sophisticated
 * typography, auto-collapsing timeline that reveals the agent's work as it
 * happens. Complexity is hidden by default; every detail is one click away.
 */

import { Check, ChevronDown, ChevronRight, FolderOpen, Paperclip, Plus, Send, Square } from "lucide-react"
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { AskUserPrompt } from "../components/AskUserPrompt"
import { AttachmentChips, type PendingAttachment } from "../components/AttachmentChips"
import { CodeBlock, extractToolCode } from "../components/CodeBlock"
import { SmartAnswer } from "../components/SmartAnswer"
import { TypewriterAnswer } from "../components/TypewriterAnswer"
import { RunStatus } from "../enums"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type { AgentDefinition, TraceEntry, WorkspaceDiff } from "../types"
import { formatMs } from "../util"

// Local cap mirrors the Fastify route limit. Larger files get a friendly
// inline error instead of round-tripping for a 413.
const ATTACH_MAX_BYTES = 32 * 1024 * 1024
const USER_GOAL_COLLAPSE_LINES = 8

function isUserGoalOverflowing(node: HTMLDivElement): boolean {
  const prevDisplay = node.style.display
  const prevOrient = node.style.webkitBoxOrient
  const prevClamp = node.style.webkitLineClamp
  const prevOverflow = node.style.overflow

  node.style.display = "-webkit-box"
  node.style.webkitBoxOrient = "vertical"
  node.style.webkitLineClamp = String(USER_GOAL_COLLAPSE_LINES)
  node.style.overflow = "hidden"

  const overflowing = node.scrollHeight > node.clientHeight + 1

  node.style.display = prevDisplay
  node.style.webkitBoxOrient = prevOrient
  node.style.webkitLineClamp = prevClamp
  node.style.overflow = prevOverflow

  return overflowing
}

function UserGoalText({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const textRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return

    const measure = () => {
      setCollapsible(isUserGoalOverflowing(node))
    }

    measure()

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => measure())
      : null
    observer?.observe(node)
    window.addEventListener("resize", measure)

    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [text])

  return (
    <div className="space-y-2">
      <div
        ref={textRef}
        className="whitespace-pre-wrap break-words"
        style={collapsible && !expanded
          ? {
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: USER_GOAL_COLLAPSE_LINES,
              overflow: "hidden",
            }
          : undefined}
      >
        {text}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-text-muted transition-colors hover:text-text"
        >
          <span>{expanded ? "Show less" : "Show more"}</span>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
    </div>
  )
}

// ── Trace → Timeline model ────────────────────────────────────────

interface ToolRow {
  id: string
  tool: string
  summary: string
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

interface ResponseProgressPart {
  kind: "progress"
  id: string
  label: string
  status: "running" | "done" | "error"
  detail?: string
  shimmer?: boolean
}

interface ResponseToolPart {
  kind: "tool"
  id: string
  row: ToolRow
}

// One agent-loop iteration's worth of tool calls, grouped under a single
// summary header that the user can collapse/expand. This is the Copilot-
// style "encapsulation" of a turn — multiple actions roll up into one
// short sentence describing what the iteration did, with the per-action
// detail tucked behind a chevron.
interface ResponseIterationPart {
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

interface ResponseMarkdownPart {
  kind: "markdown"
  id: string
  text: string
  streaming?: boolean
}

interface ResponseNarrativePart {
  kind: "narrative"
  id: string
  text: string
  tone?: "neutral" | "error"
}

interface ResponseInputPart {
  kind: "input"
  id: string
  question: string
  options?: string[]
  sensitive?: boolean
}

interface ResponseErrorPart {
  kind: "error"
  id: string
  text: string
}

type ResponsePart = ResponseProgressPart | ResponseToolPart | ResponseIterationPart | ResponseMarkdownPart | ResponseNarrativePart | ResponseInputPart | ResponseErrorPart

// Invisible marker the backend prepends to LLM-polished failure replies.
// Mirrors POLISHED_FAILURE_MARKER in packages/agent/src/application/core/planner-cluster/platform-errors.ts.
const POLISHED_FAILURE_MARKER = "\u2063pfm:\u2063"
function stripFailureMarker(text: string): string {
  return text.startsWith(POLISHED_FAILURE_MARKER) ? text.slice(POLISHED_FAILURE_MARKER.length) : text
}

function isRunActiveStatus(status: string | null | undefined): boolean {
  return status === RunStatus.Pending || status === RunStatus.Running || status === RunStatus.Planning
}

function StatusDot({ status, animated = true }: { status: "running" | "done" | "error"; animated?: boolean }) {
  if (status === "running") {
    return (
      <span className="relative flex shrink-0 w-4 h-4 items-center justify-center">
        {animated && <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-text-faint opacity-50" />}
        <span className="relative inline-flex rounded-full w-2 h-2 bg-text-muted" />
      </span>
    )
  }
  if (status === "done") {
    return (
      <span className="flex shrink-0 items-center justify-center w-4 h-4 rounded-full border border-text-muted">
        <Check size={8} strokeWidth={2} className="text-text-muted" />
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center justify-center w-4 h-4 rounded-full border border-border-subtle">
      <span className="inline-flex h-2 w-2 rounded-full bg-text-faint" />
    </span>
  )
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "read",
  write_file: "write",
  replace_in_file: "edit",
  list_dir: "list",
  grep_search: "search",
  file_search: "find",
  search_files: "search",
  search_catalog: "search catalog",
  explore_mssql_schema: "inspect schema",
  query_mssql: "query database",
  run_command: "run",
  fetch_url: "fetch",
  browser_check: "check",
  delegate: "delegate",
  ask_user: "ask user",
}

const TOOL_PAST_TENSE: Record<string, string> = {
  read: "read files",
  write: "wrote files",
  edit: "edited files",
  list: "listed files",
  search: "searched files",
  find: "found files",
  "search catalog": "searched catalog",
  "inspect schema": "inspected schema",
  "query database": "queried database",
  run: "ran command",
  fetch: "fetched URL",
  check: "checked browser",
  delegate: "delegated work",
  "ask user": "asked user",
}
// Kept for potential future re-use; the live narrative now uses the
// richer per-target verb phrasing in TOOL_VERB / formatVerbPhrase below.
void TOOL_PAST_TENSE

// ── Narrative target extraction ────────────────────────────────────
// Each tool call carries the JSON args the model invoked it with. We
// pull out the most user-meaningful field (file path, command, URL,
// query) so the per-iteration narrative can say *what* the agent did
// instead of a generic "I read files." For unknown shapes we return
// undefined and the narrative falls back to the verb's plural noun.

// Keys are the actual tool names emitted by the agent (e.g. `run_command`,
// `read_file`). The previous version of this map keyed on the short labels
// (`run`, `read`) and silently fell through to "used run_command" — that's
// what produced the buggy "I used run_command `python3 ...`" lines.
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
  // Web / browser
  fetch_url: "fetched",
  browse_web: "browsed",
  web_search: "searched the web for",
  browser_check: "checked",
  browser_auto_login: "auto-logged into",
  browser_human_handoff: "handed off to user in",
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
  browsed: "the web",
  "searched the web for": "something",
  checked: "the browser",
  "auto-logged into": "the browser",
  "handed off to user in": "the browser",
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

function extractToolTarget(tool: string, argsFormatted: string, argsSummary: string): string | undefined {
  let args: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(argsFormatted) as unknown
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
  } catch { /* fall through to summary parsing */ }

  // Args JSON path — preferred, exposes the real field names.
  if (args) {
    for (const k of ["path", "filePath", "file", "filename", "filepath", "target"]) {
      const v = args[k]
      if (typeof v === "string" && v) return basename(v)
    }
    for (const k of ["paths", "files"]) {
      const v = args[k]
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return basename(v[0])
    }
    for (const k of ["command", "cmd"]) {
      const v = args[k]
      if (typeof v === "string" && v) return shortCommand(v)
    }
    for (const k of ["url", "href"]) {
      const v = args[k]
      if (typeof v === "string" && v) return urlHost(v)
    }
    for (const k of ["query", "pattern", "q", "search"]) {
      const v = args[k]
      if (typeof v === "string" && v) return shortQuery(v)
    }
    for (const k of ["agent", "agentId", "delegateTo", "to"]) {
      const v = args[k]
      if (typeof v === "string" && v) return v
    }
    void tool
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

function buildToolNarrative(tools: Array<{ tool: string; target?: string }>): string {
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
function buildIterationHeader(tools: Array<{ tool: string; target?: string }>): string {
  if (tools.length === 0) return "Worked on it"
  const sentence = buildToolNarrative(tools)
  // Strip leading "I " and trailing period; capitalize the verb so the
  // header reads as a label, not a sentence.
  const stripped = sentence.replace(/^I\s+/, "").replace(/\.$/, "")
  return stripped.length > 0
    ? stripped[0].toUpperCase() + stripped.slice(1)
    : "Worked on it"
}

// ── Live milestone (parent shimmer) ──────────────────────────────
// The bottom shimmer label needs to mirror what the agent is actually
// doing *right now*, not the static planner-routing label that fired
// once at the start of the iteration ("Direct"). We pick the most
// specific signal available, in priority order:
//   1. The most recent in-flight tool call → "Reading monte-carlo.html"
//   2. An iteration block whose tools are still finishing → re-use its
//      collapsed-header summary so the parent reads as a sum of work.
//   3. A still-running PRIMARY_ACTIVITY (Plan / Generating / Verifying /
//      Direct) — but only as a fallback, since these are routing names,
//      not activity descriptions.
//   4. "Thinking" if a thinking-progress is running with no tools yet.
//   5. "Working" generic fallback so the shimmer is always meaningful.
const TOOL_PRESENT_TENSE: Record<string, string> = {
  read_file:           "Reading",
  write_file:          "Writing",
  append_file:         "Appending to",
  replace_in_file:     "Editing",
  list_directory:      "Listing",
  search_files:        "Searching",
  run_command:         "Running",
  fetch_url:           "Fetching",
  browse_web:          "Browsing",
  web_search:          "Searching web for",
  browser_check:       "Checking browser",
  browser_auto_login:  "Logging into",
  browser_human_handoff: "Handing off to user in",
  delegate:            "Delegating to",
  delegate_parallel:   "Delegating in parallel to",
  ask_user:            "Asking",
  think:               "Thinking about",
  note:                "Noting",
  search_catalog:      "Searching catalog for",
  compare_catalogs:    "Comparing catalogs of",
  inspect_definition:  "Inspecting definition of",
  discover_relationships: "Mapping relationships for",
  profile_data:        "Profiling",
  explore_mssql_schema:"Inspecting schema of",
  query_mssql:         "Querying",
  export_query_to_file:"Exporting query to",
  get_chart_specs:     "Loading chart specs for",
  sync_preview:        "Previewing sync for",
  sync_execute:        "Running sync for",
  list_environments:   "Listing environments",
  list_attachments:    "Listing attachments",
  read_attachment:     "Reading attachment",
  import_attachment:   "Importing attachment",
  promote_attachment:  "Promoting attachment",
  record_table_verdict:"Recording verdict for",
}

function presentTenseLabel(tool: string, target?: string): string {
  const verb = TOOL_PRESENT_TENSE[tool]
  if (!verb) {
    // Unknown tool — humanize the snake_case name as a last resort.
    const human = tool.replace(/_/g, " ")
    return target ? `${human} ${target}` : human.charAt(0).toUpperCase() + human.slice(1)
  }
  return target ? `${verb} ${target}` : verb
}
void presentTenseLabel

// Coarse, high-level verb for the parent live shimmer ("Querying" rather
// than "Querying ;WITH latest_month AS (\n SELECT MAX(...)). Per-tool
// verbs in TOOL_PRESENT_TENSE are good for the collapsed history rows
// where targets like a filename add real signal, but the bottom shimmer
// must read as a one-word narrative state. Unknown tools fall back to
// "Working".
const LIVE_ACTIVITY_VERB: Record<string, string> = {
  read_file:               "Reading",
  write_file:              "Writing",
  replace_in_file:         "Writing",
  append_file:             "Writing",
  list_directory:          "Listing",
  search_files:            "Searching",
  search_catalog:          "Searching",
  web_search:              "Searching",
  run_command:             "Executing",
  query_mssql:             "Executing",
  export_query_to_file:    "Exporting",
  explore_mssql_schema:    "Analyzing",
  inspect_definition:      "Analyzing",
  discover_relationships:  "Analyzing",
  profile_data:            "Analyzing",
  compare_catalogs:        "Analyzing",
  fetch_url:               "Fetching",
  browse_web:              "Browsing",
  browser_check:           "Checking",
  browser_auto_login:      "Logging in",
  browser_human_handoff:   "Waiting for user",
  delegate:                "Delegating",
  delegate_parallel:       "Delegating",
  ask_user:                "Asking",
  think:                   "Thinking",
  note:                    "Noting",
  get_chart_specs:         "Loading chart specs",
  sync_preview:            "Synchronizing",
  sync_execute:            "Synchronizing",
  list_environments:       "Synchronizing",
  list_attachments:        "Reading attachments",
  read_attachment:         "Reading attachments",
  import_attachment:       "Importing attachment",
  promote_attachment:      "Promoting attachment",
  record_table_verdict:    "Reflecting",
}

function liveActivityVerb(tool: string): string {
  return LIVE_ACTIVITY_VERB[tool] ?? "Working"
}

function deriveActiveMilestoneLabel(parts: ResponsePart[]): string {
  // 1. Most recent in-flight tool — search top-level + inside iteration
  //    blocks since the build pass moves tools into blocks at boundaries.
  let lastRunningTool: ResponseToolPart | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "tool" && part.row.status === "running") {
      lastRunningTool = part
      break
    }
    if (part.kind === "iteration-block" && part.hasRunning) {
      for (let j = part.tools.length - 1; j >= 0; j--) {
        if (part.tools[j].row.status === "running") {
          lastRunningTool = part.tools[j]
          break
        }
      }
      if (lastRunningTool) break
    }
  }
  if (lastRunningTool) {
    // Parent shimmer reads as a high-level narrative verb only —
    // never the messy tool argument (long SQL, multi-line script…).
    // The collapsed history row already shows the verb + target;
    // duplicating it in the live label is noise.
    return liveActivityVerb(lastRunningTool.row.tool)
  }

  // 2. Iteration block still settling (e.g. tool finished but block
  //    not yet sealed by next iteration boundary) — mirror the header
  //    so the parent reads as the cumulative sum.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "iteration-block" && part.hasRunning) {
      return part.summary || "Working"
    }
  }

  // 3. PRIMARY_ACTIVITY fallback. Skip the bare routing decisions
  //    ("Direct") when nothing else is going on — they're not
  //    descriptive of work — and only keep the meatier ones
  //    (Plan / Generating / Verifying).
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "progress" && part.status === "running" && PRIMARY_ACTIVITY_IDS.has(part.id)) {
      if (part.id === "direct") continue   // routing label, not work
      return part.detail ? `${part.label} — ${part.detail}` : part.label
    }
  }

  // 4. Thinking with no tools yet — common at the very start of a turn.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "progress" && part.id === "thinking" && part.status === "running") {
      return "Thinking"
    }
  }

  // 5. Generic.
  return "Working"
}

// Patch a tool's status both at the top level AND inside any
// already-flushed iteration block. The build pass may have moved the
// tool into a block before its result event arrived (e.g. when an
// `iteration` boundary fired between tool-call and tool-result).
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
    if (part.kind === "iteration-block") {
      let changed = false
      const tools = part.tools.map((p) => {
        if (p.id !== invocationId) return p
        changed = true
        return { ...p, row: { ...p.row, status, details: text || p.row.details } }
      })
      if (!changed) return part
      return { ...part, tools, hasRunning: tools.some((p) => p.row.status === "running") }
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
): ResponsePart[] {
  return upsertProgressPart(parts, {
    kind: "progress",
    id,
    label,
    status,
    detail,
    shimmer,
  })
}

const PRIMARY_ACTIVITY_IDS = new Set([
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

// Build the inline pill summary (e.g. `path="/long/file/path.css"`) from
// the raw argsFormatted JSON. Always preferred over the persisted
// `argsSummary`, which historically was sliced to 60 chars server-side.
// Single-arg → `key="value"`. Multi-arg → `N args`.
function buildArgsSummary(argsFormatted: string): string {
  try {
    const parsed = JSON.parse(argsFormatted) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length === 0) return ""
    if (entries.length === 1) {
      const [k, v] = entries[0]
      return `${k}=${JSON.stringify(v)}`
    }
    return `${entries.length} args`
  } catch {
    return ""
  }
}

function humanizeStepName(stepName: string): string {
  return stepName.replace(/_/g, " ")
}

function pushNarrativePart(
  parts: ResponsePart[],
  id: string,
  text: string,
  tone: "neutral" | "error" = "neutral",
): ResponsePart[] {
  const trimmedText = text.trim()
  if (!trimmedText) return parts
  if (parts.some((part) => part.kind === "narrative" && part.id === id)) return parts
  return parts.concat({ kind: "narrative", id, text: trimmedText, tone })
}

// Guard against rendering fragmentary thinking previews that look like
// jibberish in the chat (e.g. "The generic key search noisy target"
// when the model emitted a clipped reasoning blurb). We require the
// text to read as a complete-ish thought: end with sentence punctuation
// AND be long enough to actually carry meaning. When the gate rejects,
// the bottom shimmer takes over and the user sees a live activity hint
// instead of a frozen-looking partial sentence.
function looksLikeCompleteThought(text: string): boolean {
  const t = text.trim()
  if (t.length < 40) return false
  return /[.!?…"”'’)\]]$/.test(t)
}

// Mid-stream guard for `liveStreamingAnswer`. Returns the longest prefix
// of `text` that ends at a sentence terminator (or paragraph break) so
// the chat only ever shows complete sentences. Anything past the last
// terminator is held back — that tail is incomplete and would otherwise
// freeze on screen as a fragment between iterations.
//
// Terminator family kept in sync with `looksLikeCompleteThought` so the
// live-stream gate and the post-iteration thinking gate agree on what
// "a complete thought" looks like.
//
// Falls back to the last paragraph break (\n\n) when there is no
// sentence terminator — useful when the model emits markdown chunks
// (lists / code) that don't end in punctuation but ARE structurally
// complete at the paragraph boundary. Returns "" when nothing is yet
// complete; the caller suppresses the markdown part and the bottom
// "Working / Executing / …" shimmer takes over.
function truncateToLastCompleteSentence(text: string): string {
  const t = text.replace(/\s+$/, "")
  if (!t) return ""
  // Scan for the last sentence terminator that is followed by whitespace
  // or end-of-string — that is the boundary the model has actually
  // closed. A terminator mid-word (e.g. "v1.2" or "Dr.") is excluded by
  // the lookahead.
  const re = /[.!?…"”'’)\]](?=\s|$)/g
  let lastTerm = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) lastTerm = m.index
  if (lastTerm >= 0) return t.slice(0, lastTerm + 1)
  // No sentence terminator yet. If the buffer spans multiple paragraphs
  // (e.g. a streamed markdown list), keep everything before the last
  // paragraph break so the partial last paragraph is held back.
  const lastBreak = text.lastIndexOf("\n\n")
  if (lastBreak > 0) return text.slice(0, lastBreak).replace(/\s+$/, "")
  return ""
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
  if (entry.validationCode) notes.push(`blocked by ${entry.validationCode}`)
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
      ? entry.validationCode
      : notes !== "blocked"
        ? notes
        : "validator refused the query"
    return { text: `I caught a problem in my own SQL before sending it (${reason}).`, tone: "error" }
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

// Stable signature of an SQL-quality event for coalescing identical
// consecutive retries into a single "× N" narrative line. Identical
// signature == "this is the same failure we already narrated"; bump the
// counter instead of stacking a duplicate line.
function sqlQualitySignature(
  entry: Extract<TraceEntry, { kind: "planner-sql-quality" }>,
): string {
  if (entry.phase === "failed") return `failed::${cleanSqlError(entry.error)}`
  if (entry.phase === "blocked") return `blocked::${entry.validationCode ?? summarizeSqlQualityEntry(entry)}`
  return `executed::${summarizeSqlQualityEntry(entry)}`
}

function preserveToggleAnchor(button: HTMLButtonElement | null, toggle: () => void) {
  if (!button) {
    toggle()
    return
  }
  const scrollHost = button.closest(".overflow-y-auto") as HTMLDivElement | null
  const beforeTop = button.getBoundingClientRect().top
  toggle()
  requestAnimationFrame(() => {
    if (!scrollHost || !button.isConnected) return
    const afterTop = button.getBoundingClientRect().top
    scrollHost.scrollTop += afterTop - beforeTop
  })
}

function buildResponseParts(
  trace: TraceEntry[],
  runStatus: string,
  liveStreamingAnswer: string,
  finalAnswer: string | null,
  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null,
  runId: string,
): ResponsePart[] {
  let parts: ResponsePart[] = []
  const runningSteps = new Map<string, string>()
  let currentPipelineAttempt = 1
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
  // SQL-quality coalescing state. Consecutive sql-quality events that
  // produce the same narrative signature (same blocker / same server
  // error) are collapsed into one narrative line with a "(× N)" suffix
  // — three retries of the same `Invalid column name 'pkMonth'` now
  // read as one line, not three identical lines that look like the
  // agent is stuck in a loop.
  let lastSqlNarrative: {
    sig: string
    narrativeId: string
    count: number
    baseText: string
    tone: "neutral" | "error"
  } | null = null

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
        // Copilot-style: render the agent's actual reasoning as a paragraph
        // in the thread. We keep the leadsToTool gate so we don't double-up
        // pre-answer thinking with the streamed answer that follows it.
        let leadsToTool = false
        for (let j = index + 1; j < trace.length; j++) {
          const next = trace[j].kind
          if (next === "tool-call") { leadsToTool = true; break }
          if (next === "thinking" || next === "answer") break
        }
        if (leadsToTool && entry.text.trim() && looksLikeCompleteThought(entry.text)) {
          parts = pushNarrativePart(parts, `narrative-thinking-${index}`, entry.text.trim())
        }
        break
      }
      case "planning_preflight":
        parts = settlePrimaryActivities(parts, "plan")
        parts = setActivityPart(parts, "plan", "Plan", "running", undefined, true)
        break
      case "planner-decision": {
        const label = !entry.shouldPlan || entry.route === "direct" || entry.route === "single_artifact_direct_burst"
          ? "Direct"
          : entry.route === "bounded_coherent_generation"
            ? "Generating"
            : "Plan"
        const activityId = label === "Direct"
          ? "direct"
          : label === "Generating"
            ? "generation"
            : "plan"
        parts = settlePrimaryActivities(parts, activityId)
        parts = setActivityPart(parts, activityId, label, "running", undefined, true)
        break
      }
      case "planner-generating":
        parts = settlePrimaryActivities(parts, "plan")
        parts = setActivityPart(parts, "plan", "Plan", "running", "Generating plan...", true)
        break
      case "planner-plan-generated":
        parts = setActivityPart(parts, "plan", "Plan", "done", `${entry.stepCount} step${entry.stepCount !== 1 ? "s" : ""}`)
        parts = pushNarrativePart(parts, `narrative-plan-${index}`, `I mapped out a ${entry.stepCount}-step approach.`)
        break
      case "coherent-generation-start":
        parts = settlePrimaryActivities(parts, "generation")
        parts = setActivityPart(parts, "generation", "Generating", "running", undefined, true)
        break
      case "coherent-generation-bundle":
        parts = settlePrimaryActivities(parts, "generation")
        parts = setActivityPart(parts, "generation", "Generating", "running", `${entry.artifactCount} file${entry.artifactCount !== 1 ? "s" : ""}`, true)
        break
      case "coherent-generation-materialized":
        parts = setActivityPart(parts, "generation", "Generating", "done", `${entry.artifactCount} file${entry.artifactCount !== 1 ? "s" : ""} written`)
        parts = pushNarrativePart(parts, `narrative-materialized-${index}`, `I generated ${entry.artifactCount} file${entry.artifactCount !== 1 ? "s" : ""}.`)
        break
      case "coherent-generation-failed":
        parts = setActivityPart(parts, "generation", "Generating", "error", entry.stage)
        parts = pushNarrativePart(parts, `narrative-generation-failed-${index}`, "I hit a problem while generating the result.", "error")
        break
      case "planner-pipeline-start":
        currentPipelineAttempt = entry.attempt
        parts = setActivityPart(parts, `pipeline-${entry.attempt}`, "Pipeline", "running", entry.attempt > 1 ? `attempt ${entry.attempt}` : undefined, true)
        break
      case "planner-pipeline-end": {
        parts = setActivityPart(parts, `pipeline-${currentPipelineAttempt}`, "Pipeline", entry.status === "success" ? "done" : "error", `${entry.completedSteps}/${entry.totalSteps} steps`)
        parts = pushNarrativePart(
          parts,
          `narrative-pipeline-${index}`,
          entry.status === "success"
            ? `I finished the planned flow across ${entry.completedSteps} step${entry.completedSteps !== 1 ? "s" : ""}.`
            : `The planned flow stopped after ${entry.completedSteps} of ${entry.totalSteps} steps.`,
          entry.status === "success" ? "neutral" : "error",
        )
        break
      }
      case "planner-step-start": {
        runningSteps.set(entry.stepName, "activity")
        parts = setActivityPart(parts, `step-${entry.stepName}`, `Generating ${humanizeStepName(entry.stepName)}`, "running")
        break
      }
      case "planner-step-end": {
        if (runningSteps.has(entry.stepName)) {
          parts = setActivityPart(
            parts,
            `step-${entry.stepName}`,
            `Generating ${humanizeStepName(entry.stepName)}`,
            entry.status === "pass" || entry.status === "success" ? "done" : "error",
            entry.durationMs ? formatMs(entry.durationMs) : entry.error,
          )
          parts = pushNarrativePart(
            parts,
            `narrative-step-${entry.stepName}-${index}`,
            entry.status === "pass" || entry.status === "success"
              ? `I completed ${humanizeStepName(entry.stepName)}.`
              : `I ran into a problem during ${humanizeStepName(entry.stepName)}.`,
            entry.status === "pass" || entry.status === "success" ? "neutral" : "error",
          )
          runningSteps.delete(entry.stepName)
        }
        break
      }
      case "planner-verification":
        parts = settlePrimaryActivities(parts, "verification")
        parts = setActivityPart(parts, "verification", "Verifying", entry.overall === "pass" ? "done" : entry.overall === "fail" ? "error" : "running", undefined, entry.overall !== "pass" && entry.overall !== "fail")
        if (entry.overall === "pass") {
          parts = pushNarrativePart(parts, `narrative-verification-${index}`, "I checked the result and it passed verification.")
        } else if (entry.overall === "fail") {
          parts = pushNarrativePart(parts, `narrative-verification-${index}`, "I found an issue while verifying the result.", "error")
        }
        break
      case "planner-repair-plan":
        parts = setActivityPart(parts, `repair-${entry.attempt}`, "Repairing", "running", `attempt ${entry.attempt}`, true)
        parts = pushNarrativePart(parts, `narrative-repair-${index}`, `I found an issue and started repair attempt ${entry.attempt}.`, "error")
        break
      case "planner-sql-quality": {
        const summary = summarizeSqlQualityEntry(entry)
        const status: "done" | "error" = entry.phase === "blocked" || entry.phase === "failed" || !!entry.validationCode ? "error" : "done"
        // Compact "SQL review" progress chip — short phase tag plus a
        // hint of the cause so the chip itself carries signal even
        // before the narrative line below.
        const chipDetail =
          entry.phase === "failed"
            ? `failed: ${cleanSqlError(entry.error) || "server error"}`
            : entry.phase === "blocked"
              ? `blocked: ${entry.validationCode ?? summary}`
              : summary
        parts = parts.concat({
          kind: "progress",
          id: `sql-quality-${index}`,
          label: "SQL review",
          status,
          detail: chipDetail,
        })
        const { text, tone } = describeSqlQualityForChat(entry)
        if (!text) {
          // executed cleanly with no notes — no chat narration needed.
          lastSqlNarrative = null
          break
        }
        const sig = sqlQualitySignature(entry)
        if (lastSqlNarrative && lastSqlNarrative.sig === sig) {
          // Same blocker / same server error as the immediately previous
          // sql-quality narrative — bump the retry counter in place
          // instead of stacking a duplicate line.
          lastSqlNarrative.count += 1
          const narrId = lastSqlNarrative.narrativeId
          const updatedText = `${lastSqlNarrative.baseText} (× ${lastSqlNarrative.count})`
          parts = parts.map((part) =>
            part.kind === "narrative" && part.id === narrId
              ? { ...part, text: updatedText }
              : part,
          )
        } else {
          const narrativeId = `narrative-sql-quality-${index}`
          parts = pushNarrativePart(parts, narrativeId, text, tone)
          lastSqlNarrative = { sig, narrativeId, count: 1, baseText: text, tone }
        }
        break
      }
      case "direct_loop_fallback":
        parts = settlePrimaryActivities(parts, "direct")
        parts = setActivityPart(parts, "direct", "Direct", "running", undefined, true)
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
            // Recompute from argsFormatted so historically-persisted
            // traces (which had argsSummary sliced to 60 chars) also
            // render the full single-arg value. Fall back to the
            // persisted argsSummary only if JSON parsing fails.
            summary: buildArgsSummary(entry.argsFormatted) || entry.argsSummary || compactToolPreview(entry.argsFormatted),
            argsFormatted: entry.argsFormatted,
            // details holds the OUTPUT only — populated on tool-result /
            // tool-error. argsFormatted holds the INPUT separately.
            details: undefined,
            status: "running",
          },
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
        parts = patchToolStatus(parts, entry.invocationId, "error", entry.text)
        pendingTools = pendingTools.map((p) =>
          p.id === entry.invocationId
            ? { ...p, row: { ...p.row, status: "error", details: entry.text || p.row.details } }
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
    // ── Mid-stream fragment guard ────────────────────────────────
    //
    // `liveStreamingAnswer` is the raw accumulating token buffer for the
    // current iteration's LLM response. It includes intermediate
    // reasoning text — the model's "I'm going to look at X next" pre-
    // tool narration — and gets cleared by `stream.reset` once tool
    // calls arrive. Between bursts (network jitter, the model pausing,
    // a tool taking a few seconds to return) the buffer often holds a
    // truncated half-sentence like "I have attributes next product, fast"
    // that sits frozen on screen for several seconds and reads as
    // jibberish. Worse, while ANY text exists in the buffer we suppress
    // the bottom "Executing / Planning / Thinking" shimmer (see
    // `hasStreamingAnswer` below) — so the UI looks completely stalled.
    //
    // Fix: only render whole sentences. Anything after the last sentence
    // terminator is held back until the model closes it. When the
    // truncated string is empty, we don't push a markdown part at all —
    // and the bottom shimmer carries the "we're still working" signal
    // for the user. The held-back tail will appear the moment the model
    // emits its terminator (or in the next iteration's complete-thinking
    // entry, which has its own gate).
    const display = truncateToLastCompleteSentence(stripFailureMarker(liveStreamingAnswer))
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
      return part
    })
  }

  return parts
}

function canElementScrollVertically(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false
  if (deltaY < 0) return el.scrollTop > 0
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 1
  return false
}

function findNestedScrollable(target: EventTarget | null, container: HTMLDivElement): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== container) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function isNearBottom(el: HTMLDivElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

// Inline scrollable detail area for raw (non-extracted) tool payloads.
// Inherits the surrounding panel background (no dark slab) and applies
// a soft fade mask on top/bottom only when content actually overflows
// the height cap, so rows visually dissolve into the edge as the user
// scrolls instead of being hard-clipped.
function ScrollMaskedDetails({ text, maxHeight }: { text: string; maxHeight: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollHeight > el.clientHeight + 1
      setEdges({
        top: overflow && el.scrollTop > 0,
        bottom: overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      })
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [text])

  const maskStyle = useMemo<React.CSSProperties>(() => {
    // Top-only fade — same rationale as IterationToolList.
    if (!edges.top) return {}
    const mask = `linear-gradient(180deg, transparent 0px, black 22px, black 100%)`
    return { WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" }
  }, [edges.top])

  return (
    <div
      ref={ref}
      className="overflow-auto px-3 py-2.5 text-[12px] leading-6 font-mono text-text-secondary whitespace-pre-wrap break-words"
      style={{ maxHeight, ...maskStyle }}
    >
      {text}
    </div>
  )
}

function ToolPill({ row, isLast }: { row: ToolRow; isLast: boolean }) {
  const label = TOOL_LABELS[row.tool] ?? row.tool
  const calmRunning = row.status === "running" && row.tool === "ask_user"
  const [expanded, setExpanded] = useState(false)
  // Pill preview uses `summary` (short — argsSummary like `command="python3 -"`
  // or extracted target). The expanded body now renders TWO blocks: the
  // raw input (argsFormatted, e.g. the full `command` or `query`) and
  // the tool's output (details). Previously the expanded body showed
  // only the output — the input was hidden once the result arrived
  // because `details` was overloaded for both.
  const previewText = compactToolPreview(row.summary || "")
  const hasInput = Boolean(row.argsFormatted && row.argsFormatted.trim().length > 0)
  const hasOutput = Boolean(row.details && row.details.trim().length > 0)
  const canExpand = hasInput || hasOutput
  const extractedInput = row.argsFormatted ? extractToolCode(row.tool, row.argsFormatted) : null
  const extractedOutput = row.details ? extractToolCode(row.tool, row.details) : null
  const isError = row.status === "error"
  const buttonRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="relative py-0.5">
      {!isLast && <div className="pointer-events-none absolute left-[11px] top-[20px] -bottom-1 w-px bg-border-subtle" />}
      <div className="flex items-start gap-2 min-w-0 px-2 py-1">
        <span className={["shrink-0 w-1.5 h-1.5 rounded-full mt-[7px]", row.status === "running" ? calmRunning ? "bg-text-muted" : "bg-text-secondary animate-pulse" : row.status === "done" ? "bg-text-muted" : "bg-text-faint"].join(" ")} />
        {/* Cap the pill content (label + preview) at 80% of the
            iteration-column width before CSS ellipsis kicks in, so even
            short paths leave breathing room on the right and the
            timeline doesn't feel edge-to-edge. */}
        <div className="min-w-0 flex-1 max-w-[80%]">
          {canExpand ? (
            <button
              ref={buttonRef}
              type="button"
              onClick={() => preserveToggleAnchor(buttonRef.current, () => setExpanded((value) => !value))}
              className="inline-flex min-w-0 max-w-full items-center gap-2 text-left transition-colors outline-none focus-visible:outline-none group cursor-pointer"
              style={{ width: "fit-content", maxWidth: "100%" }}
            >
              <span className="text-[12px] font-mono text-text-muted group-hover:text-text transition-colors">{label}</span>
              {previewText && !expanded && (
                <span
                  className="text-[12px] text-text-faint group-hover:text-text transition-colors font-mono min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
                >
                  {previewText}
                </span>
              )}
            </button>
          ) : (
            <div className="flex min-w-0 max-w-full items-center gap-2">
              <span className="text-[12px] font-mono text-text-muted transition-colors">{label}</span>
              {previewText && !expanded && (
                <span className="text-[12px] text-text-faint font-mono min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis">
                  {previewText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {expanded && (hasInput || hasOutput) && (
        <div className="ml-[14px] mt-1 pl-3 space-y-2">
          {hasInput && row.argsFormatted && (
            <div className="rounded-md border border-border-subtle overflow-hidden">
              {extractedInput ? (
                <CodeBlock code={extractedInput.code} lang={extractedInput.lang} maxHeight={176} />
              ) : (
                <ScrollMaskedDetails text={row.argsFormatted} maxHeight={176} />
              )}
            </div>
          )}
          {hasOutput && row.details && (
            <div className={`rounded-md border overflow-hidden ${isError ? "border-error/40 bg-error-soft/30" : "border-border-subtle bg-overlay-1"}`}>
              {extractedOutput ? (
                <CodeBlock code={extractedOutput.code} lang={extractedOutput.lang} maxHeight={176} />
              ) : (
                <ScrollMaskedDetails text={row.details} maxHeight={176} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// One agent-loop iteration's worth of tool calls, encapsulated under a
// single collapsible header. Default-collapsed once the iteration is
// done so the thread stays scannable; auto-expanded while the
// iteration is still running so the user sees live activity.
function IterationBlock({ part }: { part: ResponseIterationPart }) {
  const [open, setOpen] = useState(part.hasRunning)
  // If a previously-collapsed block flips back to running (rare — only
  // happens via re-render with stale state), respect that and re-expand.
  // We don't auto-collapse on transition to done: once the user opened
  // it, it stays open; once an iteration finishes naturally we collapse
  // it ONLY if the user hasn't interacted yet.
  const userToggledRef = useRef(false)
  const wasRunningRef = useRef(part.hasRunning)
  useEffect(() => {
    if (userToggledRef.current) return
    if (wasRunningRef.current && !part.hasRunning) {
      // Just finished — collapse now that the action is over.
      setOpen(false)
    } else if (part.hasRunning) {
      setOpen(true)
    }
    wasRunningRef.current = part.hasRunning
  }, [part.hasRunning])

  const buttonRef = useRef<HTMLButtonElement>(null)
  const errored = part.tools.some((p) => p.row.status === "error")
  // Visual hierarchy: the block header is *system chrome* describing
  // what the agent did — it should read as muted grey so the bright
  // assistant prose (`NarrativeUpdate` paragraphs and the final answer)
  // visually dominate. Mirrors GitHub Copilot Chat's grey "Searched for
  // X / Updated Y" rows alternating with white assistant text.
  const headerToneClass = errored ? "text-text-faint" : "text-text-faint"
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="py-1.5">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggleAnchor(buttonRef.current, () => {
          userToggledRef.current = true
          setOpen((v) => !v)
        })}
        className={`inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-[13px] leading-6 transition-colors hover:text-text-secondary ${headerToneClass}`}
      >
        <Chevron size={12} strokeWidth={1.5} className="text-text-faint shrink-0" />
        <span>{part.summary}</span>
      </button>
      {open && (
        <div className="mt-0.5 pl-4 border-l border-border-subtle ml-[5px]">
          <IterationToolList tools={part.tools} />
        </div>
      )}
    </div>
  )
}

// Caps the expanded iteration body so a single tool-call burst can't
// monopolise the chat viewport. Once content overflows the cap, the
// list becomes scrollable and rows visually dissolve into the top/bottom
// edges via a CSS mask so they "disappear" gradually rather than being
// hard-clipped. Auto-sticks to the bottom while running so newly
// appended tool rows stay in view.
const ITERATION_BODY_MAX_HEIGHT = 300

function IterationToolList({ tools }: { tools: ResponseToolPart[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const [edges, setEdges] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollHeight > el.clientHeight + 1
      setEdges({
        top: overflow && el.scrollTop > 0,
        bottom: overflow && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      })
    }
    const onScroll = () => {
      stickBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
      update()
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight
    update()
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(() => {
      if (stickBottomRef.current) el.scrollTop = el.scrollHeight
      update()
    })
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [tools.length])

  const maskStyle = useMemo<React.CSSProperties>(() => {
    // Top-only fade — rows visually dissolve into the upper edge as you
    // scroll past them. No bottom fade: the bottom of the list is the
    // "current" content (we auto-stick there) and a fade there would
    // suggest hidden content even when there isn't any.
    if (!edges.top) return {}
    const mask = `linear-gradient(180deg, transparent 0px, black 28px, black 100%)`
    return { WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat" }
  }, [edges.top])

  return (
    <div
      ref={ref}
      className="overflow-y-auto"
      style={{ maxHeight: ITERATION_BODY_MAX_HEIGHT, ...maskStyle }}
    >
      {tools.map((toolPart, i) => (
        <ToolPill
          key={toolPart.id}
          row={toolPart.row}
          isLast={i === tools.length - 1}
        />
      ))}
    </div>
  )
}

function ProgressPill({ part }: { part: ResponseProgressPart }) {
  const hasDetail = Boolean(part.detail)

  return (
    <div className={`flex gap-3 py-1.5 min-w-0 ${hasDetail ? "items-start" : "items-center"}`}>
      <StatusDot status={part.status} animated={part.shimmer === true} />
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-normal tracking-[-0.01em] block text-text-muted">{part.label}</span>
        {part.detail && (
          <div className="pt-0.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-text-faint">
            {part.detail}
          </div>
        )}
      </div>
    </div>
  )
}

function NarrativeUpdate({ part }: { part: ResponseNarrativePart }) {
  // The agent's reasoning is real prose — render it as compact markdown
  // in the *primary text tone* (bright zinc-100) so it visually
  // dominates the muted grey iteration-block headers above and below it.
  // This is the Copilot pattern: alternating bands of grey system rows
  // and bright assistant prose.
  return (
    <div className={`py-1.5 pr-2 ${part.tone === "error" ? "text-text-muted" : "text-text"}`}>
      <SmartAnswer text={part.text} compact />
    </div>
  )
}

function ActiveMilestone({ part }: { part: ResponseProgressPart }) {
  // Retained for potential future re-use; the flat-thread refactor now
  // shows a single bottom "Working" shimmer in renderedParts instead.
  const text = part.detail ? `${part.label} — ${part.detail}` : part.label
  return (
    <div className="py-1.5 pr-2">
      <span
        className="activity-shimmer-tight text-[13px] leading-6 font-normal inline-block"
        style={{ "--sa": "var(--color-text)", "--sd": "var(--color-text-faint)" } as React.CSSProperties}
      >
        {text}
      </span>
    </div>
  )
}
void ActiveMilestone

function DetailViewport({
  children,
  maxHeight = 300,
}: {
  children: React.ReactNode
  maxHeight?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const [overflowState, setOverflowState] = useState({ hasOverflow: false, top: false, bottom: false })

  const viewportMaskStyle = useMemo<React.CSSProperties>(() => {
    // Fade rows in/out as they cross the viewport edges so they feel like
    // they gradually disappear instead of being hard-clipped. Only apply
    // the fade on edges that actually have hidden content beyond them.
    const topFade = overflowState.top ? 28 : 0
    const bottomFade = overflowState.bottom ? 28 : 0

    if (topFade === 0 && bottomFade === 0) {
      return {}
    }

    const maskImage = `linear-gradient(180deg, transparent 0px, black ${topFade}px, black calc(100% - ${bottomFade}px), transparent 100%)`

    return {
      WebkitMaskImage: maskImage,
      maskImage,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
    }
  }, [overflowState.top, overflowState.bottom])

  useLayoutEffect(() => {
    const host = hostRef.current
    const inner = innerRef.current
    if (!host || !inner) return

    const updateOverflow = () => {
      const hasOverflow = host.scrollHeight > host.clientHeight + 1
      setOverflowState({
        hasOverflow,
        top: hasOverflow && host.scrollTop > 0,
        bottom: hasOverflow && host.scrollTop + host.clientHeight < host.scrollHeight - 1,
      })
    }

    const scrollToBottom = () => {
      host.scrollTop = host.scrollHeight
      updateOverflow()
    }

    const onScroll = () => {
      shouldStickToBottomRef.current = host.scrollTop + host.clientHeight >= host.scrollHeight - 24
      updateOverflow()
    }

    if (shouldStickToBottomRef.current) {
      scrollToBottom()
    } else {
      updateOverflow()
    }

    const resizeObserver = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollToBottom()
        return
      }
      updateOverflow()
    })
    resizeObserver.observe(inner)
    host.addEventListener("scroll", onScroll, { passive: true })

    return () => {
      resizeObserver.disconnect()
      host.removeEventListener("scroll", onScroll)
    }
  }, [children])

  return (
    <div className="mt-1 rounded-xl overflow-hidden">
      <div ref={hostRef} className="relative overflow-y-auto" style={{ maxHeight, ...viewportMaskStyle }}>
        <div ref={innerRef} className="relative z-0 px-2 pt-3 pb-4">
          {children}
        </div>
      </div>
    </div>
  )
}

function DetailViewportRows({
  parts,
  maxHeight,
}: {
  parts: Array<ResponseProgressPart | ResponseToolPart>
  maxHeight?: number
}) {
  return (
    <DetailViewport maxHeight={maxHeight}>
      <div className="space-y-0.5">
        {parts.map((part, index) => (
          part.kind === "progress"
            ? <ProgressPill key={`${part.id}-${index}`} part={part} />
            : <ToolPill key={`${part.id}-${index}`} row={part.row} isLast={index === parts.length - 1} />
        ))}
      </div>
    </DetailViewport>
  )
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return ""
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

function summarizeHistory(parts: Array<ResponseProgressPart | ResponseToolPart>): string {
  const tools = parts
    .filter((part): part is ResponseToolPart => part.kind === "tool")
    .map((part) => ({
      tool: part.row.tool,
      target: extractToolTarget(part.row.tool, part.row.details ?? "", part.row.summary ?? ""),
    }))

  if (tools.length > 0) {
    // Strip the leading "I " from the narrative so the disclosure label
    // reads as a phrase, not a sentence ("read store.ts and 2 more").
    const sentence = buildToolNarrative(tools).replace(/^I\s+/, "").replace(/\.$/, "")
    if (sentence) return sentence
  }

  const lastProgress = [...parts].reverse().find((part): part is ResponseProgressPart => part.kind === "progress")
  return lastProgress?.label ?? "Technical flow"
}

function HistoryDisclosure({
  parts,
}: {
  parts: Array<ResponseProgressPart | ResponseToolPart>
}) {
  const [open, setOpen] = useState(false)
  const summary = summarizeHistory(parts)
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (parts.length === 0) return null

  return (
    <div className="pt-1 pb-4">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => preserveToggleAnchor(buttonRef.current, () => setOpen((value) => !value))}
        className="inline-flex max-w-full items-center gap-1.5 py-1 text-left text-[13px] text-text-faint hover:text-text-secondary transition-colors"
      >
        {open ? <ChevronDown size={12} strokeWidth={1.5} className="text-text-faint shrink-0" /> : <ChevronRight size={12} strokeWidth={1.5} className="text-text-faint shrink-0" />}
        <span className="truncate">{summary}</span>
      </button>

      {open && (
        <div className="pt-0.5 pl-1">
          <DetailViewportRows parts={parts} maxHeight={280} />
        </div>
      )}
    </div>
  )
}
void HistoryDisclosure

// ── Workspace diff pill ───────────────────────────────────────────

function WorkspaceDiffCard({ runId }: { runId: string }) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const upsertRun = useStore((s) => s.upsertRun)

  useEffect(() => {
    api.getRunWorkspaceDiff(runId).then(setDiff).catch(() => {/* ignore */ })
  }, [runId])

  async function apply() {
    setApplying(true)
    setError(null)
    try {
      await api.applyRunWorkspaceDiff(runId)
      upsertRun({ id: runId, pendingWorkspaceChanges: 0 })
      setApplied(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed")
      setApplying(false)
    }
  }

  const total = diff?.total ?? 0
  const hasPathContext = Boolean(diff?.executionRoot || diff?.sourceRoot)

  if (applied) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-text-faint font-mono">
        <Check size={10} className="text-text-faint" />
        <span>saved to workspace</span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border-subtle overflow-hidden">
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
        onClick={() => setOpen((x) => !x)}
      >
        <FolderOpen size={12} strokeWidth={1.5} className="shrink-0 text-text-faint" />
        <span className="text-[13px] text-text-muted flex-1">
          {diff ? `${total} file${total !== 1 ? "s" : ""} changed` : "File changes ready"}
        </span>
        {open ? <ChevronDown size={12} strokeWidth={1.5} className="text-text-faint" /> : <ChevronRight size={12} strokeWidth={1.5} className="text-text-faint" />}
      </button>

      {open && diff && (
        <div className="px-3 pb-2 space-y-0.5 border-t border-border-subtle">
          {diff.added.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[12px] font-mono">
              <span className="text-success shrink-0">+</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.modified.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[12px] font-mono">
              <span className="text-warning shrink-0">~</span>
              <span className="text-text-muted truncate">{f}</span>
            </div>
          ))}
          {diff.deleted.map((f) => (
            <div key={f} className="flex items-center gap-1.5 text-[12px] font-mono">
              <span className="text-error shrink-0">−</span>
              <span className="text-text-faint truncate line-through">{f}</span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="px-3 pb-2 text-[11px] text-error">{error}</p>
      )}

      {hasPathContext && (
        <div className="px-3 py-2 border-t border-border-subtle bg-overlay-1 space-y-1">
          {diff?.executionRoot && (
            <div className="text-[11px] text-text-faint font-mono break-all">
              from {diff.executionRoot}
            </div>
          )}
          {diff?.sourceRoot && (
            <div className="text-[11px] text-text-muted font-mono break-all">
              to {diff.sourceRoot}
            </div>
          )}
        </div>
      )}

      <div className="px-3 pb-2 flex gap-2 border-t border-border-subtle">
        <button
          className="flex-1 mt-2 px-3 py-1.5 rounded-lg border border-border bg-transparent hover:bg-overlay-hover text-[13px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-30"
          onClick={apply}
          disabled={applying || !diff}
        >
          {applying ? "Saving…" : "Save to workspace"}
        </button>
      </div>
    </div>
  )
}

// ── Run message block ─────────────────────────────────────────────

function RunMessageImpl({
  run,
  isActive,
  pendingInput,
  onRespond,
}: {
  run: {
    id: string
    status: string
    answer: string | null
    error: string | null
    pendingWorkspaceChanges?: number
    trace?: TraceEntry[]
    streamingAnswer?: string
  }
  isActive: boolean
  pendingInput?: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  onRespond: (response: string) => void
}) {
  const upsertRun = useStore((s) => s.upsertRun)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestedTraceRef = useRef(false)
  const [isNearViewport, setIsNearViewport] = useState(false)
  const trace = run.trace ?? []
  const liveStreamingAnswer = isActive && isRunActiveStatus(run.status) ? (run.streamingAnswer ?? "") : ""
  const responseParts = useMemo(
    () => buildResponseParts(trace, run.status, liveStreamingAnswer, run.answer, pendingInput ?? null, run.id),
    [trace, run.status, liveStreamingAnswer, run.answer, pendingInput, run.id],
  )
  const isDone = !isRunActiveStatus(run.status)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: "600px 0px" },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isDone) return
    if (!isNearViewport) return
    if (trace.length > 0) return
    if (requestedTraceRef.current) return

    requestedTraceRef.current = true
    api.getRunTrace(run.id)
      .then((rawTrace) => {
        upsertRun({
          id: run.id,
          trace: rawTrace as TraceEntry[],
          streamingAnswer: "",
          coherentStream: "",
        })
      })
      .catch(() => {
        requestedTraceRef.current = false
      })
  }, [isDone, isNearViewport, run.id, trace.length, upsertRun])

  const renderedParts = useMemo(() => {
    // Copilot-style flat thread: every responsePart renders as a single
    // row in chronological order. No DetailViewport buffering, no
    // HistoryDisclosure aggregation, no ActiveMilestone footer. The
    // assistant's prose paragraphs (narrative) and tool-action lines
    // sit as siblings at the same indent level — that's the layout
    // the user is going for.
    const items: React.ReactNode[] = []

    let lastToolHasRunning = false

    responseParts.forEach((part) => {
      if (part.kind === "progress") {
        // Internal planner phases (Plan / Direct / Generating / Verifying /
        // Pipeline / step-*) are bookkeeping. They produce no narrative
        // text the user benefits from — the tool calls and the agent's
        // thinking already tell the story. Suppress entirely from the
        // visible thread; the bottom shimmer covers "still working".
        return
      }

      if (part.kind === "tool") {
        // A trailing tool that hasn't been folded into an iteration block
        // yet (lives at the head of the in-flight iteration). Render it
        // as its own line; once the next iteration boundary fires it
        // will be replaced by an iteration-block.
        items.push(<ToolPill key={part.id} row={part.row} isLast={false} />)
        if (part.row.status === "running") lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "iteration-block") {
        items.push(<IterationBlock key={part.id} part={part} />)
        if (part.hasRunning) lastToolHasRunning = true
        else lastToolHasRunning = false
        return
      }

      if (part.kind === "narrative") {
        items.push(<NarrativeUpdate key={part.id} part={part} />)
        return
      }

      if (part.kind === "input") {
        items.push(
          <AskUserPrompt
            key={part.id}
            question={part.question}
            options={part.options}
            sensitive={part.sensitive}
            onSubmit={onRespond}
          />,
        )
        return
      }

      if (part.kind === "markdown") {
        // Always route through TypewriterAnswer so the local reveal cursor
        // gets a chance to animate the tail of the final answer if the
        // run completed before the typewriter caught up. TypewriterAnswer
        // hands off to SmartAnswer once streaming=false AND the cursor
        // has reached the end of the text.
        items.push(
          <TypewriterAnswer
            key={part.id}
            text={part.text}
            streaming={part.streaming === true}
            compact
          />,
        )
        return
      }

      if (part.kind === "error") {
        items.push(<div key={part.id} className="text-[13px] text-error font-mono">{part.text}</div>)
      }
    })

    // Single bottom shimmer — the persistent "we're still working"
    // milestone indicator. Shown whenever the run is active and we're
    // not already streaming the final answer. We deliberately keep it
    // visible while a tool row is also pulsing (the per-tool dot
    // signals that *this* tool is active; the shimmer signals that the
    // overall iteration / agent loop is still progressing — they answer
    // different questions for the user).
    const hasStreamingAnswer = responseParts.some(
      (p) => p.kind === "markdown" && p.streaming === true,
    )
    // Pick the milestone label from the most recent primary activity
    // part if any, otherwise fall back to a generic "Working".
    let milestoneLabel = deriveActiveMilestoneLabel(responseParts)
    if (!isDone && !hasStreamingAnswer) {
      // Suppress `lastToolHasRunning` to silence noise (avoid unused warning)
      void lastToolHasRunning
      items.push(
        <div key="active-shimmer" className="py-1.5 pr-2">
          <span className="activity-shimmer-tight text-[13px] leading-6 font-normal inline-block text-text-muted">
            {milestoneLabel}
          </span>
        </div>,
      )
    }

    return items
  }, [isDone, onRespond, responseParts])

  // Show workspace diff card when run completes with file changes
  const showDiff = isDone && (run.pendingWorkspaceChanges ?? 0) > 0

  return (
    <div ref={containerRef} className="space-y-3">
      {renderedParts.length > 0 && (
        <div className="pl-1 space-y-0">
          {renderedParts}
        </div>
      )}

      {/* Error */}
      {run.error && (
        <div className="text-[13px] text-error font-mono">{run.error}</div>
      )}

      {/* Workspace diff */}
      {showDiff && <WorkspaceDiffCard runId={run.id} />}
    </div>
  )
}

// Memoize so completed runs don't re-render every time the active run's
// trace ticks. Active run still re-renders because its `run` reference
// changes on each batched store update.
const RunMessage = React.memo(RunMessageImpl, (prev, next) => {
  return (
    prev.run === next.run
    && prev.isActive === next.isActive
    && prev.onRespond === next.onRespond
    // pendingInput only matters for the run it targets
    && (prev.pendingInput?.runId === next.pendingInput?.runId
      ? prev.pendingInput?.question === next.pendingInput?.question
      : prev.pendingInput?.runId !== next.run.id && next.pendingInput?.runId !== next.run.id)
  )
})

const FORCE_EMPTY_STATE_PREVIEW = false
const HOME_CHAT_MAX_WIDTH_CLASS = "max-w-[840px]"

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function smoothstep(min: number, max: number, value: number): number {
  if (max === min) return value >= max ? 1 : 0
  const t = clamp01((value - min) / (max - min))
  return t * t * (3 - 2 * t)
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t
}

function TermChatInputBar({
  input,
  isRunning,
  pendingInput,
  sending,
  textareaRef,
  attachments,
  onChange,
  onKeyDown,
  onCancel,
  onSend,
  onAttach,
  onRemoveAttachment,
  className = "w-[90%]",
  variant = "default",
  heroRevealProgress = 1,
}: {
  input: string
  isRunning: boolean
  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  sending: boolean
  textareaRef: React.Ref<HTMLTextAreaElement>
  attachments: PendingAttachment[]
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onCancel: () => void
  onSend: () => void
  onAttach: () => void
  onRemoveAttachment: (id: string) => void
  className?: string
  variant?: "default" | "hero"
  heroRevealProgress?: number
}) {
  const attachDisabled = isRunning || !!pendingInput
  const isHero = variant === "hero"
  const reveal = Math.pow(smoothstep(0.46, 1, clamp01(heroRevealProgress)), 1.35)
  const heroStyle: React.CSSProperties | undefined = isHero
    ? {
        opacity: reveal,
        filter: `blur(${lerp(6, 0, reveal).toFixed(2)}px) saturate(${lerp(0.88, 1, reveal).toFixed(3)})`,
        boxShadow: reveal > 0.94 ? "var(--hero-pill-shadow-live, var(--hero-pill-shadow))" : "none",
      }
    : undefined
  return (
      <div
          data-intro-target="termchat-input"
          className={`${className} mx-auto bg-elevated dark:bg-overlay-2 border border-border ring-1 ring-overlay-1 focus-within:border-border-strong focus-within:ring-overlay-2 transition-colors ${isHero ? "rounded-[24px] px-5 py-4" : "rounded-2xl px-4 py-3"}`}
          style={heroStyle}
      >
          <AttachmentChips items={attachments} onRemove={onRemoveAttachment} />
          {isHero ? (
              <div className="flex flex-col gap-3">
                  <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus
                      placeholder={
                          pendingInput
                              ? "Respond in the prompt above ↑"
                              : "Enter your goal or question here..."
                      }
                      rows={1}
                      disabled={isRunning || !!pendingInput}
                      className="min-w-0 bg-transparent resize-none text-[15px] leading-6 text-text placeholder:text-text-faint focus:outline-none max-h-36 overflow-y-auto disabled:opacity-30"
                  />
                  <div className="flex items-center justify-between gap-3 pt-1.5">
                      <div className="flex items-center gap-1.5">
                          <button
                              type="button"
                              onClick={onAttach}
                              disabled={attachDisabled}
                              title="Attach file"
                              aria-label="Attach file"
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl text-text-faint hover:text-text hover:bg-overlay-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-faint"
                          >
                              <Plus size={18} />
                          </button>
                      </div>
                      {isRunning ? (
                          <button
                              type="button"
                              onClick={onCancel}
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-overlay-2 hover:bg-error/12 text-error transition-colors"
                              title="Cancel"
                          >
                              <Square size={16} fill="currentColor" />
                          </button>
                      ) : (
                          <button
                              type="button"
                              onClick={onSend}
                              disabled={
                                  (!input.trim() && attachments.length === 0) ||
                                  sending
                              }
                              className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-overlay-2 hover:bg-overlay-hover text-text-muted hover:text-text transition-colors disabled:opacity-30"
                              title="Send"
                          >
                              <Send size={18} />
                          </button>
                      )}
                  </div>
              </div>
          ) : (
              <div className="flex items-center gap-2">
                  <button
                      type="button"
                      onClick={onAttach}
                      disabled={attachDisabled}
                      title="Attach file"
                      aria-label="Attach file"
                      className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg text-text-faint hover:text-text hover:bg-overlay-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-faint"
                  >
                      <Paperclip size={16} />
                  </button>
                  <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={onKeyDown}
                      autoFocus
                      placeholder={
                          pendingInput
                              ? "Respond in the prompt above ↑"
                              : "Enter your goal or question here..."
                      }
                      rows={1}
                      disabled={isRunning || !!pendingInput}
                      className="flex-1 min-w-0 bg-transparent resize-none text-[15px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none max-h-36 overflow-y-auto disabled:opacity-30"
                  />
                  {isRunning ? (
                      <button
                          type="button"
                          onClick={onCancel}
                          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-error-soft hover:bg-error/25 text-error transition-colors"
                          title="Cancel"
                      >
                          <Square size={16} fill="currentColor" />
                      </button>
                  ) : (
                      <button
                          type="button"
                          onClick={onSend}
                          disabled={
                              (!input.trim() && attachments.length === 0) ||
                              sending
                          }
                          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-accent hover:bg-accent-hover text-text-on-accent transition-colors disabled:opacity-40"
                          title="Send"
                      >
                          <Send size={16} />
                      </button>
                  )}
              </div>
          )}
      </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────

export function TermChat({ mode = "widget", heroRevealProgress = 1 }: { mode?: "widget" | "home"; heroRevealProgress?: number } = {}) {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  const { me } = useMe()

  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const pendingInput = useStore((s) => s.pendingInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)

  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = isRunActiveStatus(activeRun?.status)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollHostRef = useRef<HTMLDivElement>(null)
  const transcriptInnerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const previousActiveRunIdRef = useRef<string | null>(null)

  // Reset the textarea to its intrinsic 1-row height when empty and to
  // its content's scrollHeight when not. Called both from the callback
  // ref (so a freshly-mounted textarea — e.g. when the empty-state ↔
  // chat-state JSX swap toggles which copy of the input bar is in the
  // tree — gets sized correctly on its very first paint) AND from the
  // input-change layout effect below (so it grows/shrinks as the user
  // types). Skipping the scrollHeight write when value is empty matters
  // because otherwise we'd lock in whatever scrollHeight the browser
  // reports for an empty textarea (varies by font load + layout context),
  // which is the root cause of the "input box is huge until F5" bug.
  const autosizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = "auto"
    if (el.value.length > 0) {
      el.style.height = `${el.scrollHeight}px`
    }
  }, [])

  const setTextareaRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el
    autosizeTextarea(el)
  }, [autosizeTextarea])

  // Load agents
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => { /* ignore */ })
  }, [])

  // Follow new output only when the transcript is already pinned near the bottom.
  // Using direct scrollTop updates avoids the visible whole-pane smooth-scroll flicker.
  useLayoutEffect(() => {
    const host = scrollHostRef.current
    if (!host) return
    const activeRunChanged = previousActiveRunIdRef.current !== activeRunId
    previousActiveRunIdRef.current = activeRunId
    if (activeRunChanged || shouldStickToBottomRef.current) {
      host.scrollTop = host.scrollHeight
      shouldStickToBottomRef.current = true
    }
  }, [activeRunId, runs.length, activeRun?.trace?.length, activeRun?.coherentStream, activeRun?.streamingAnswer])

  // Keep the transcript pinned during internal content growth (for example the
  // shared word-by-word answer reveal) without forcing scroll when the user has
  // intentionally moved away from the bottom.
  useEffect(() => {
    const host = scrollHostRef.current
    const inner = transcriptInnerRef.current
    if (!host || !inner) return

    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) return
      host.scrollTop = host.scrollHeight
    })

    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // Auto-grow textarea as the user types. Uses useLayoutEffect so the
  // height is committed before the browser paints — no visible jump.
  useLayoutEffect(() => {
    autosizeTextarea(textareaRef.current)
  }, [input, autosizeTextarea])

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents.find((a) => a.id === "default") ?? agents[0]

  const send = useCallback(async () => {
    const goal = input.trim()
    // Allow attachments-only sends (e.g. "summarise this file"). The
    // server requires a non-empty goal string, so synthesise a minimal
    // one in that case rather than refusing.
    if (!goal && pendingAttachments.length === 0) return
    if (sending || isRunning) return
    const effectiveGoal = goal || `Review the attached file${pendingAttachments.length === 1 ? "" : "s"}.`
    const attachmentIds = pendingAttachments.map((a) => a.id)
    setInput("")
    setSending(true)
    try {
      const { runId } = await api.startRun(effectiveGoal, selectedAgent?.id, attachmentIds.length > 0 ? attachmentIds : undefined)
      setActiveRun(runId)
      // Only clear chips after a successful start so the user doesn't
      // lose context if the request failed mid-flight.
      setPendingAttachments([])
      setAttachError(null)
    } catch (e) {
      // Surface the server error and ensure the chat doesn't get stuck on
      // "Working". A failed startRun never produces a runs row, so any
      // activeRunId we may have optimistically picked up from an SSE
      // race must be cleared too.
      const msg = e instanceof Error ? e.message : String(e)
      setAttachError(`Failed to start run: ${msg}`)
      setActiveRun(null)
      setInput(goal)
    } finally {
      setSending(false)
    }
  }, [input, sending, isRunning, selectedAgent, setActiveRun, pendingAttachments])

  const cancel = useCallback(async () => {
    if (!activeRunId) return
    try { await api.cancelRun(activeRunId) } catch { /* ignore */ }
  }, [activeRunId])

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setAttachError(null)
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) {
        setAttachError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — max ${ATTACH_MAX_BYTES / 1024 / 1024} MB per attachment`)
        continue
      }
      try {
        const meta = await api.uploadAttachment(file)
        setPendingAttachments((prev) => [
          ...prev,
          { id: meta.id, name: meta.normalizedName, sizeBytes: meta.sizeBytes, mediaType: meta.mediaType },
        ])
      } catch (e) {
        setAttachError(`Upload failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
    // Best-effort soft-delete; UI removal is the user's source of truth.
    void api.deleteAttachment(id).catch(() => { /* ignore */ })
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleRespond = useCallback(async (response: string) => {
    if (!pendingInput) return
    clearPendingInput()
    try { await api.respondToRun(pendingInput.runId, response) } catch { /* ignore */ }
  }, [pendingInput, clearPendingInput])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  useEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) return

      const nestedScrollable = findNestedScrollable(event.target, host)
      if (!nestedScrollable || nestedScrollable === host) return
      if (canElementScrollVertically(nestedScrollable, event.deltaY)) return

      event.preventDefault()
      host.scrollTop += event.deltaY
    }

    host.addEventListener("wheel", handleWheel, { capture: true, passive: false })
    return () => host.removeEventListener("wheel", handleWheel, { capture: true })
  }, [])

  const onTranscriptScroll = useCallback(() => {
    const host = scrollHostRef.current
    if (!host) return
    shouldStickToBottomRef.current = isNearBottom(host)
  }, [])

  // Build message list: each "run" is a (user msg, assistant response) pair.
  // Show every non-active run (terminal OR in-flight) as history, oldest
  // first, with the active run pinned at the bottom so the input bar
  // anchors to the most recent activity. Including in-flight runs here
  // matters: if `activeRunId` ever drifts to a different run (another
  // widget calling setActiveRun, an unrelated background SSE event, etc.)
  // the run the user just started would otherwise vanish from view.
  const displayRuns = useMemo(() => {
    const history = runs
      .filter((r) => r.id !== activeRunId)
      .slice()
      .reverse()
    if (activeRun) return [...history, activeRun]
    return history
  }, [runs, activeRunId, activeRun])

  const showEmptyState = FORCE_EMPTY_STATE_PREVIEW || displayRuns.length === 0
  const isHomeMode = mode === "home"

  return (
    <div
      className="relative flex flex-col h-full bg-transparent text-text font-sans"
      onDragEnter={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the drag actually leaves the shell — child
        // boundaries fire dragleave too and would otherwise flicker.
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return
        e.preventDefault()
        setDragOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) void uploadFiles(files)
      }}
    >
      {/* Hidden picker — opened by the paperclip button in the input bar. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void uploadFiles(files)
          // Reset so re-selecting the same file still fires onChange.
          e.target.value = ""
        }}
      />

      {dragOver && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none rounded-md border-2 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]"
        >
          <div className="px-4 py-2 rounded-lg bg-panel-2 border border-border text-text text-[14px] font-medium shadow-lg">
            Drop to attach
          </div>
        </div>
      )}

      {/* Message list */}
      <div
        ref={scrollHostRef}
        onScroll={onTranscriptScroll}
        className={`relative flex-1 overflow-y-auto min-h-0 ${isHomeMode && showEmptyState ? "px-6 pt-8 pb-10" : isHomeMode ? "px-6 pt-2 pb-5 space-y-8" : "px-6 py-5 space-y-10"}`}
      >
        <div
          ref={transcriptInnerRef}
          className={showEmptyState
            ? `w-[90%] ${isHomeMode ? `${HOME_CHAT_MAX_WIDTH_CLASS} pb-[10vh]` : "max-w-[1400px]"} min-h-full mx-auto flex flex-col justify-center`
            : `relative z-10 w-[90%] ${isHomeMode ? HOME_CHAT_MAX_WIDTH_CLASS : "max-w-[1400px]"} mx-auto`
          }
        >
          {showEmptyState && (
            <div className={`chathome-empty-state relative flex flex-col items-center justify-center px-6 text-center ${isHomeMode ? "min-h-[68vh]" : "min-h-[58vh]"}`}>
              {isHomeMode && (
                <div
                  aria-hidden="true"
                  className="chathome-empty-spotlight pointer-events-none absolute inset-x-0 top-1/2 h-[360px] -translate-y-[16%]"
                />
              )}
              <div className={`relative z-10 w-full ${isHomeMode ? `${HOME_CHAT_MAX_WIDTH_CLASS} space-y-8` : "max-w-[860px] space-y-8"}`}>
                <div className={`chathome-empty-copy ${isHomeMode ? "space-y-3" : "space-y-2"}`}>
                  <p className={isHomeMode ? "text-[clamp(1.8rem,3.8vw,3.1rem)] leading-[1.02] tracking-[-0.04em] text-text font-medium" : "text-[24px] leading-tight tracking-[-0.02em] text-text font-medium"}>
                    {isHomeMode ? "How can I help?" : "What are you working on?"}
                  </p>
                  <p className={isHomeMode ? "text-[14px] leading-6 text-text-muted max-w-[520px] mx-auto" : "text-[13px] leading-5 text-text-muted max-w-[520px] mx-auto"}>
                    {isHomeMode
                      ? "Start with a goal, question, or task."
                      : "Query business data, inspect metadata or run environment synchronization."}
                  </p>
                </div>
                <div className="chathome-empty-input">
                  <TermChatInputBar
                    input={input}
                    isRunning={isRunning}
                    pendingInput={pendingInput}
                    sending={sending}
                    textareaRef={setTextareaRef}
                    attachments={pendingAttachments}
                    onChange={setInput}
                    onKeyDown={onKey}
                    onCancel={cancel}
                    onSend={send}
                    onAttach={openFilePicker}
                    onRemoveAttachment={removeAttachment}
                    className={isHomeMode ? `w-full ${HOME_CHAT_MAX_WIDTH_CLASS}` : "w-full max-w-[860px]"}
                    variant={isHomeMode ? "hero" : "default"}
                    heroRevealProgress={heroRevealProgress}
                  />
                </div>
                {attachError && (
                  <p className="-mt-4 text-[12px] text-error text-center">{attachError}</p>
                )}
              </div>
            </div>
          )}

          {!showEmptyState && displayRuns.map((run) => (
            <div key={run.id} className="space-y-6">
              {/* User goal — with optional attribution for admin-view runs */}
              <div className={`flex justify-end ${isHomeMode ? "py-2" : "py-8"}`}>
                {run.upn && run.upn.toLowerCase() !== me?.upn?.toLowerCase() && (
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="text-[11px] font-medium text-text-muted uppercase tracking-wide px-1.5">
                      {run.displayName ?? run.upn}
                    </span>
                    <div
                      className="max-w-[82%] px-4 py-2.5 bg-panel-2 dark:bg-bubble-user border border-border-subtle rounded-2xl text-[15px] text-text leading-relaxed"
                      style={{ boxShadow: "var(--shadow-bubble)" }}
                    >
                      <UserGoalText text={run.goal} />
                    </div>
                  </div>
                )}
                {(!run.upn || run.upn.toLowerCase() === me?.upn?.toLowerCase()) && (
                  <div
                    className="max-w-[82%] px-4 py-2.5 bg-panel-2 dark:bg-bubble-user border border-border-subtle rounded-2xl text-[15px] text-text leading-relaxed"
                    style={{ boxShadow: "var(--shadow-bubble)" }}
                  >
                    <UserGoalText text={run.goal} />
                  </div>
                )}
              </div>

              {/* Agent response */}
              <div className={isHomeMode ? "" : "pr-6"}>
                <RunMessage
                  run={run}
                  isActive={run.id === activeRunId}
                  pendingInput={pendingInput}
                  onRespond={handleRespond}
                />
              </div>
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar — no separator line */}
      {!showEmptyState && (
        <div className="shrink-0 px-5 pb-5">
          <TermChatInputBar
            input={input}
            isRunning={isRunning}
            pendingInput={pendingInput}
            sending={sending}
            textareaRef={setTextareaRef}
            attachments={pendingAttachments}
            onChange={setInput}
            onKeyDown={onKey}
            onCancel={cancel}
            onSend={send}
            onAttach={openFilePicker}
            onRemoveAttachment={removeAttachment}
            className={isHomeMode ? `w-full ${HOME_CHAT_MAX_WIDTH_CLASS}` : "w-[90%]"}
            variant={isHomeMode ? "hero" : "default"}
            heroRevealProgress={heroRevealProgress}
          />
          {attachError && (
            <p className="mt-1.5 text-[12px] text-error text-center">{attachError}</p>
          )}
        </div>
      )}
    </div>
  )
}
