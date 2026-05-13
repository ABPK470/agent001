/**
 * TermChat — GitHub-style agent chat.
 *
 * Design: tokenized neutral palette (theme-driven via index.css), sophisticated
 * typography, auto-collapsing timeline that reveals the agent's work as it
 * happens. Complexity is hidden by default; every detail is one click away.
 */

import { Check, ChevronDown, ChevronRight, FolderOpen, Send, Square } from "lucide-react"
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { AskUserPrompt } from "../components/AskUserPrompt"
import { CodeBlock, extractToolCode } from "../components/CodeBlock"
import { SmartAnswer } from "../components/SmartAnswer"
import { TypewriterAnswer } from "../components/TypewriterAnswer"
import { useStore } from "../store"
import type { AgentDefinition, TraceEntry, WorkspaceDiff } from "../types"
import { formatMs } from "../util"

// ── Trace → Timeline model ────────────────────────────────────────

interface ToolRow {
  id: string
  tool: string
  summary: string
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
// Mirrors POLISHED_FAILURE_MARKER in packages/agent/src/planner/platform-errors.ts.
const POLISHED_FAILURE_MARKER = "\u2063pfm:\u2063"
function stripFailureMarker(text: string): string {
  return text.startsWith(POLISHED_FAILURE_MARKER) ? text.slice(POLISHED_FAILURE_MARKER.length) : text
}

function isRunActiveStatus(status: string | null | undefined): boolean {
  return status === "pending" || status === "running" || status === "planning"
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
  read_file: "read",
  write_file: "wrote",
  replace_in_file: "edited",
  list_dir: "listed",
  grep_search: "searched",
  search_files: "searched",
  file_search: "found",
  run_command: "ran",
  fetch_url: "fetched",
  browser_check: "checked",
  delegate: "delegated to",
  ask_user: "asked",
  search_catalog: "searched catalog for",
  explore_mssql_schema: "inspected schema of",
  query_mssql: "queried",
}

const VERB_DEFAULT_NOUN: Record<string, string> = {
  read: "files",
  wrote: "files",
  edited: "files",
  listed: "a directory",
  searched: "the codebase",
  found: "files",
  ran: "a command",
  fetched: "a URL",
  checked: "the browser",
  "delegated to": "a subagent",
  asked: "a question",
  "searched catalog for": "tables",
  "inspected schema of": "a table",
  queried: "the database",
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
    return `${verb} ${VERB_DEFAULT_NOUN[verb] ?? "something"}`
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
        if (leadsToTool && entry.text.trim()) {
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
      case "direct_loop_fallback":
        parts = settlePrimaryActivities(parts, "direct")
        parts = setActivityPart(parts, "direct", "Direct", "running", undefined, true)
        break
      case "tool-call": {
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
            details: entry.argsFormatted,
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
    parts = parts.map((part) =>
      part.kind === "progress" && part.status === "running" && PRIMARY_ACTIVITY_IDS.has(part.id)
        ? { ...part, status: "done", shimmer: false }
        : part,
    )
    parts.push({ kind: "markdown", id: `answer-${runId}`, text: stripFailureMarker(liveStreamingAnswer), streaming: true })
  } else if (finalAnswer) {
    // Pass streaming=true if the run is still active (rare race: completed
    // but render hasn't observed it yet), false otherwise. TypewriterAnswer
    // will continue revealing whatever portion isn't yet on screen and
    // then hand off to SmartAnswer for full markdown rendering.
    const stillStreaming = isRunActiveStatus(runStatus)
    parts.push({ kind: "markdown", id: `answer-${runId}`, text: stripFailureMarker(finalAnswer), streaming: stillStreaming })
  }

  if (!isRunActiveStatus(runStatus)) {
    const terminalStatus: "done" | "error" = runStatus === "completed" ? "done" : "error"
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
  // or extracted target). The full `details` JSON only appears in the
  // expanded body. Previously we used details first, which dumped raw
  // JSON-with-newline-escapes onto the pill line.
  const previewText = compactToolPreview(row.summary || "")
  const canExpand = Boolean(row.details && row.details.trim().length > 0)
  const extracted = row.details ? extractToolCode(row.tool, row.details) : null
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
      {expanded && row.details && (
        <div className="ml-[14px] mt-0.5 pl-3">
          {extracted ? (
            <CodeBlock code={extracted.code} lang={extracted.lang} maxHeight={176} />
          ) : (
            <ScrollMaskedDetails text={row.details} maxHeight={176} />
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
    <div className="rounded-xl border border-border-subtle bg-overlay-1 overflow-hidden">
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

    // Single bottom shimmer — the only "current activity" indicator,
    // matching Copilot's behaviour. We show it whenever the run is still
    // active AND we're not currently streaming the final answer AND no
    // tool-call row is already pulsing as running (which would make the
    // shimmer redundant).
    const hasStreamingAnswer = responseParts.some(
      (p) => p.kind === "markdown" && p.streaming === true,
    )
    if (!isDone && !hasStreamingAnswer && !lastToolHasRunning) {
      items.push(
        <div key="active-shimmer" className="py-1.5 pr-2">
          <span className="activity-shimmer-tight text-[13px] leading-6 font-normal inline-block text-text-muted">
            Working
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

// ── Main widget ───────────────────────────────────────────────────

export function TermChat() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [agents, setAgents] = useState<AgentDefinition[]>([])

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const previousActiveRunIdRef = useRef<string | null>(null)

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

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents.find((a) => a.id === "default") ?? agents[0]

  const send = useCallback(async () => {
    const goal = input.trim()
    if (!goal || sending || isRunning) return
    setInput("")
    setSending(true)
    try {
      const { runId } = await api.startRun(goal, selectedAgent?.id)
      setActiveRun(runId)
    } catch {
      // handled by global error state
    } finally {
      setSending(false)
    }
  }, [input, sending, isRunning, selectedAgent, setActiveRun])

  const cancel = useCallback(async () => {
    if (!activeRunId) return
    try { await api.cancelRun(activeRunId) } catch { /* ignore */ }
  }, [activeRunId])

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

  // Build message list: each "run" is a (user msg, assistant response) pair
  // Show all non-active terminal runs + the active one at the end
  const displayRuns = useMemo(() => {
    const TERMINAL = new Set(["completed", "failed", "cancelled"])
    const completed = runs
      .filter((r) => r.id !== activeRunId && TERMINAL.has(r.status))
      .slice()
      .reverse()
    if (activeRun) return [...completed, activeRun]
    return completed
  }, [runs, activeRunId, activeRun])

  return (
    <div className="flex flex-col h-full bg-transparent text-text font-sans">
      {/* Message list */}
      <div
        ref={scrollHostRef}
        onScroll={onTranscriptScroll}
        className="flex-1 overflow-y-auto px-6 py-5 space-y-10 min-h-0"
      >
        <div
          ref={transcriptInnerRef}
          className="w-[90%] max-w-[1400px] mx-auto"
        >
          {displayRuns.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-[15px] text-text-faint">
                What can I build for you?
              </p>
            </div>
          )}

          {displayRuns.map((run) => (
            <div key={run.id} className="space-y-6">
              {/* User goal */}
              <div className="flex justify-end py-8">
                <div
                  className="max-w-[82%] px-4 py-2.5 bg-panel-2 dark:bg-bubble-user border border-border-subtle rounded-2xl text-[15px] text-text leading-relaxed"
                  style={{ boxShadow: "var(--shadow-bubble)" }}
                >
                  {run.goal}
                </div>
              </div>

              {/* Agent response */}
              <div className="pr-6">
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
      <div className="shrink-0 px-5 pb-5">
        <div className="w-[90%] mx-auto flex items-center gap-2 bg-panel-2 dark:bg-overlay-2 border border-border rounded-2xl px-4 py-3 ring-1 ring-overlay-1 focus-within:border-border-strong focus-within:ring-overlay-2 transition-colors">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              pendingInput ? "Respond in the prompt above ↑" : "Enter a goal…"
            }
            rows={1}
            disabled={isRunning || !!pendingInput}
            className="flex-1 min-w-0 bg-transparent resize-none text-[15px] text-text placeholder:text-text-faint focus:outline-none leading-relaxed max-h-36 overflow-y-auto disabled:opacity-30"
          />
          {isRunning ? (
            <button
              type="button"
              onClick={cancel}
              className="shrink-0 flex items-center justify-center w-9 h-9 bg-error-soft hover:bg-error/25 text-error rounded-lg transition-colors"
              title="Cancel"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim() || sending}
              className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent hover:bg-accent-hover text-text-on-accent rounded-lg transition-colors disabled:opacity-40"
              title="Send"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
