/**
 * LogPane — right half. The unified operations log.
 *
 * Every SSE envelope flows in. The user can:
 *   - Free-text search (substring over message + JSON)
 *   - Prefix filters:  type:llm-request   group:agent   run:<id>   err:1
 *   - Hit Ctrl+F from anywhere to focus the filter
 *   - Click a row to expand a kind-specific detail view
 *
 * Detail unpacking:
 *   The orchestrator broadcasts every iteration as `debug.trace` whose
 *   `data.entry` is one of {system-prompt, tools-resolved, llm-request,
 *   llm-response, iteration, thinking, usage, nudge}. We surface those
 *   subtypes as first-class rows with proper summaries and renderers
 *   so SQL queries, full prompts, tool args, and tool results are all
 *   visible without diffing raw JSON. (Tool call results travel back as
 *   role:"tool" messages inside the next llm-request — expand it.)
 *
 * Color taxonomy is per-source — see categoryFor().
 */

import type { CSSProperties } from "react"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { WsEvent } from "../types"
import { PaneHeader } from "./StreamPane"

export interface LogPaneHandle {
  focusFilter(): void
  clearFilter(): void
  jumpToBottom(): void
  toggleFollow(): void
  focusScroll(): void
}

interface Props {
  active: boolean
  events: WsEvent[]
  activeRunId: string | null
}

type Category =
  | "run" | "step" | "agent" | "tool" | "audit"
  | "sync" | "system" | "debug" | "error"

const CAT_COLOR: Record<Category, string> = {
  run:    "var(--c-run)",
  step:   "var(--c-step)",
  agent:  "var(--c-llm)",
  tool:   "var(--c-tool)",
  audit:  "var(--c-audit)",
  sync:   "var(--c-sync)",
  system: "var(--fg-dim)",
  debug:  "var(--c-debug)",
  error:  "var(--c-error)",
}

// ---------------------------------------------------------------------------
// Effective type / category derivation
// ---------------------------------------------------------------------------

/** Pull entry.kind out of debug.trace so the row label is meaningful. */
function effectiveType(e: WsEvent): string {
  if (e.type === "debug.trace") {
    const entry = e.data["entry"] as { kind?: string } | undefined
    if (entry?.kind) return `agent.${entry.kind}`
  }
  return e.type
}

function categoryFor(e: WsEvent): Category {
  const t = effectiveType(e)
  if (/error|failed|cancelled/i.test(t)) return "error"
  if (t.startsWith("run."))    return "run"
  if (t.startsWith("step."))   return "step"
  if (t.startsWith("agent.") || t.startsWith("llm.")) return "agent"
  if (t.startsWith("tool.") || t.includes("tool_"))   return "tool"
  if (t.startsWith("audit.") || t.includes("user"))   return "audit"
  if (t.startsWith("sync."))   return "sync"
  if (t.startsWith("debug."))  return "debug"
  return "system"
}

// ---------------------------------------------------------------------------
// One-line summaries
// ---------------------------------------------------------------------------

function trunc(s: string, n: number): string {
  if (!s) return ""
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

interface LlmMessage {
  role?: string
  content?: string
  toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown }>
  toolCallId?: string | null
}

interface LlmResponseEntry {
  iteration?: number
  durationMs?: number
  content?: string
  toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown }>
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null
}

function summarize(e: WsEvent): string {
  // debug.trace subtypes — these carry the real action.
  if (e.type === "debug.trace") {
    const entry = e.data["entry"] as Record<string, unknown> | undefined
    const kind = entry?.["kind"] as string | undefined
    if (entry && kind) {
      switch (kind) {
        case "system-prompt": {
          const text = String(entry["text"] ?? "")
          return `${text.length.toLocaleString()} chars`
        }
        case "tools-resolved": {
          const tools = entry["tools"] as Array<{ name?: string }> | undefined
          const names = (tools ?? []).map((t) => t.name).filter(Boolean).join(", ")
          return `${tools?.length ?? 0} tools — ${trunc(names, 180)}`
        }
        case "llm-request": {
          const iter = entry["iteration"] as number | undefined
          const messages = (entry["messages"] as LlmMessage[] | undefined) ?? []
          const counts: Record<string, number> = {}
          for (const m of messages) counts[m.role ?? "?"] = (counts[m.role ?? "?"] ?? 0) + 1
          const breakdown = Object.entries(counts).map(([r, n]) => `${n} ${r}`).join(", ")
          const toolCount = entry["toolCount"] as number | undefined
          return `iter ${iter ?? "?"} → ${messages.length} msgs (${breakdown}) · ${toolCount ?? 0} tools available`
        }
        case "llm-response": {
          const iter = entry["iteration"] as number | undefined
          const dur = entry["durationMs"] as number | undefined
          const content = String(entry["content"] ?? "")
          const calls = (entry["toolCalls"] as Array<{ name?: string }> | undefined) ?? []
          const usage = entry["usage"] as { totalTokens?: number } | null | undefined
          const callsLabel = calls.length
            ? `${calls.length} tool call${calls.length > 1 ? "s" : ""} (${calls.map((c) => c.name).filter(Boolean).join(", ")})`
            : content.trim()
              ? trunc(content.replace(/\s+/g, " ").trim(), 180)
              : "(empty)"
          const tail: string[] = []
          if (typeof dur === "number") tail.push(`${dur}ms`)
          if (usage?.totalTokens) tail.push(`${usage.totalTokens} tok`)
          return `iter ${iter ?? "?"} ← ${callsLabel}${tail.length ? ` · ${tail.join(" · ")}` : ""}`
        }
        case "iteration": {
          return `iteration ${entry["current"]}/${entry["max"]}`
        }
        case "thinking": {
          return trunc(String(entry["text"] ?? ""), 200)
        }
        case "usage": {
          const it = entry["iterationTokens"] as number | undefined
          const total = entry["totalTokens"] as number | undefined
          return `+${it ?? 0} tok this iter · ${total ?? 0} total`
        }
        case "nudge": {
          return `[${entry["tag"]}] ${trunc(String(entry["message"] ?? ""), 180)}`
        }
        default: {
          // Fall through to generic candidates below.
        }
      }
    }
  }

  const d = e.data
  if (e.type === "tool_call.executing") {
    return `${d["toolName"] ?? "?"} — call ${String(d["toolCallId"] ?? "").slice(0, 8)}`
  }
  if (e.type === "tool_call.completed") {
    return `call ${String(d["toolCallId"] ?? "").slice(0, 8)} done`
  }
  if (e.type === "agent.thinking") {
    return trunc(String(d["content"] ?? ""), 200)
  }
  if (e.type === "answer.chunk") {
    return trunc(String(d["chunk"] ?? ""), 200)
  }

  const candidates = ["message", "text", "summary", "chunk", "tool", "name", "answer", "error", "goal", "question"]
  for (const k of candidates) {
    const v = d[k]
    if (typeof v === "string" && v.trim()) return trunc(v, 240)
  }
  if (typeof d["argsSummary"] === "string") return String(d["argsSummary"])
  return ""
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------
//
// Two distinct axes — don't confuse them:
//
//   type:X     raw wire event type substring — matches the `type` column in the DB.
//              type:api.request   → only api.request events
//              type:sync          → all sync.* events
//              type:debug.trace   → all LLM trace events (stored as debug.trace on the wire)
//              -type:events       → exclude events.connected etc.
//
//   group:X    semantic display bucket — computed, not stored in DB.
//              run · step · agent · tool · sync · audit · debug · system · error
//              group:agent  covers debug.trace (unwrapped to agent.*) + direct agent.* events
//              group:system is the catch-all: api.request, events.connected, memory.*, answer.chunk etc.
//              Use type:X to target specific wire types within a group (e.g. type:memory, type:answer).
//              group:error  covers any type containing error / failed / cancelled
//
//   run:X      data.runId prefix — orthogonal, not a type or group
//   err:1      shorthand for group:error
//   -prefix    negation: -type:X, -group:X, -run:X
//   freetext   substring across type + summary + JSON data
//
// Tokens are AND'd; values within one token are OR'd; negations override includes.
// "kind:" is accepted as legacy alias for "group:".

interface FilterClause {
  types?:  string[]   // OR list, lowercase substrings
  kinds?:  Category[] // OR list, exact match
  runs?:   string[]   // OR list, prefix match
}

interface ParsedFilter {
  text: string
  include: FilterClause
  exclude: FilterClause
  err?: boolean
}

function splitCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

function parseFilter(raw: string): ParsedFilter {
  const out: ParsedFilter = { text: "", include: {}, exclude: {} }
  const free: string[] = []
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    const negated = tok.startsWith("-")
    const body = negated ? tok.slice(1) : tok
    const m = /^(type|group|kind|run|err):(.*)$/.exec(body)
    if (!m) { free.push(tok); continue }
    const [, key, value] = m
    const target = negated ? out.exclude : out.include
    if (key === "type") {
      target.types = [...(target.types ?? []), ...splitCsv(value.toLowerCase())]
    } else if (key === "group" || key === "kind") {
      // "failed" is an alias for "error" — they are the same group.
      const groups = splitCsv(value.toLowerCase()).map((g) => g === "failed" ? "error" : g)
      target.kinds = [...(target.kinds ?? []), ...(groups as Category[])]
    } else if (key === "run") {
      target.runs = [...(target.runs ?? []), ...splitCsv(value)]
    } else if (key === "err") {
      out.err = value === "1" || value === "true"
    }
  }
  out.text = free.join(" ").toLowerCase()
  return out
}

function clauseMatches(e: WsEvent, c: FilterClause): boolean {
  if (c.types && c.types.length) {
    // Match the raw wire type (e.type) — consistent with the DB `type` column.
    // Use e.type NOT effectiveType() so type:api.request and -type:events are
    // exact and predictable. Use group: to match by semantic bucket instead.
    const t = e.type.toLowerCase()
    if (!c.types.some((needle) => t.includes(needle))) return false
  }
  if (c.kinds && c.kinds.length) {
    const k = categoryFor(e)
    if (!c.kinds.includes(k)) return false
  }
  if (c.runs && c.runs.length) {
    const r = String(e.data["runId"] ?? "")
    if (!c.runs.some((prefix) => r.startsWith(prefix))) return false
  }
  return true
}

function matches(e: WsEvent, f: ParsedFilter): boolean {
  // Excludes: if ANY exclude clause matches, drop the row.
  if (f.exclude.types?.length || f.exclude.kinds?.length || f.exclude.runs?.length) {
    if (clauseMatches(e, f.exclude)) return false
  }
  // Includes: must match all populated keys.
  if (!clauseMatches(e, f.include)) return false
  if (f.err && categoryFor(e) !== "error") return false
  if (f.text) {
    const hay = `${effectiveType(e)} ${summarize(e)} ${JSON.stringify(e.data)}`.toLowerCase()
    if (!hay.includes(f.text)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Expanded detail renderer
// ---------------------------------------------------------------------------

const PRE_BASE: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  background: "var(--bg)",
  color: "var(--fg)",
  fontSize: "var(--fs-xs)",
  fontFamily: "var(--font-mono)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: 3,
  border: "1px solid var(--divider)",
  maxHeight: 480,
  overflow: "auto",
}

const ROLE_COLOR: Record<string, string> = {
  system:    "var(--fg-dim)",
  user:      "var(--c-audit)",
  assistant: "var(--c-llm)",
  tool:      "var(--c-tool)",
}

function fmtArgs(args: unknown): string {
  if (args == null) return ""
  if (typeof args === "string") return args
  try { return JSON.stringify(args, null, 2) } catch { return String(args) }
}

function MessageBlock({ m }: { m: LlmMessage }) {
  const role = m.role ?? "?"
  const color = ROLE_COLOR[role] ?? "var(--fg-dim)"
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color, fontSize: "var(--fs-xs)", letterSpacing: "0.06em", marginBottom: 2 }}>
        {role.toUpperCase()}
        {m.toolCallId ? <span style={{ color: "var(--fg-mute)", marginLeft: 8 }}>↳ result for {m.toolCallId.slice(0, 8)}</span> : null}
      </div>
      {m.content ? (
        <pre style={{ ...PRE_BASE, borderLeft: `2px solid ${color}` }}>{m.content}</pre>
      ) : null}
      {m.toolCalls && m.toolCalls.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          {m.toolCalls.map((tc, i) => (
            <div key={tc.id ?? i} style={{ marginTop: 4 }}>
              <div style={{ color: "var(--c-tool)", fontSize: "var(--fs-xs)" }}>
                → {tc.name} <span style={{ color: "var(--fg-mute)" }}>{tc.id?.slice(0, 8)}</span>
              </div>
              <pre style={{ ...PRE_BASE, borderLeft: "2px solid var(--c-tool)" }}>{fmtArgs(tc.arguments)}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ExpandedDetail({ e }: { e: WsEvent }) {
  if (e.type === "debug.trace") {
    const entry = e.data["entry"] as Record<string, unknown> | undefined
    const kind = entry?.["kind"] as string | undefined

    if (entry && kind === "system-prompt") {
      return <pre style={PRE_BASE}>{String(entry["text"] ?? "")}</pre>
    }
    if (entry && kind === "tools-resolved") {
      const tools = (entry["tools"] as Array<{ name?: string; description?: string; parameters?: unknown }> | undefined) ?? []
      return (
        <div>
          {tools.map((t, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ color: "var(--c-tool)", fontSize: "var(--fs-sm)" }}>{t.name}</div>
              {t.description ? <div style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", marginBottom: 2 }}>{t.description}</div> : null}
              <pre style={PRE_BASE}>{fmtArgs(t.parameters)}</pre>
            </div>
          ))}
        </div>
      )
    }
    if (entry && kind === "llm-request") {
      const messages = (entry["messages"] as LlmMessage[] | undefined) ?? []
      return (
        <div>
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", marginBottom: 6 }}>
            iteration {String(entry["iteration"])} · {messages.length} messages · {String(entry["toolCount"] ?? 0)} tools
          </div>
          {messages.map((m, i) => <MessageBlock key={i} m={m} />)}
        </div>
      )
    }
    if (entry && kind === "llm-response") {
      const resp = entry as unknown as LlmResponseEntry
      const calls = resp.toolCalls ?? []
      return (
        <div>
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", marginBottom: 6 }}>
            iteration {String(resp.iteration)}
            {resp.durationMs != null ? ` · ${resp.durationMs}ms` : ""}
            {resp.usage ? ` · ${resp.usage.totalTokens ?? 0} tok (${resp.usage.promptTokens ?? 0}p + ${resp.usage.completionTokens ?? 0}c)` : ""}
          </div>
          {resp.content ? (
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: "var(--c-llm)", fontSize: "var(--fs-xs)", letterSpacing: "0.06em", marginBottom: 2 }}>ASSISTANT</div>
              <pre style={{ ...PRE_BASE, borderLeft: "2px solid var(--c-llm)" }}>{resp.content}</pre>
            </div>
          ) : null}
          {calls.map((tc, i) => (
            <div key={tc.id ?? i} style={{ marginBottom: 6 }}>
              <div style={{ color: "var(--c-tool)", fontSize: "var(--fs-xs)" }}>
                → {tc.name} <span style={{ color: "var(--fg-mute)" }}>{tc.id?.slice(0, 8)}</span>
              </div>
              <pre style={{ ...PRE_BASE, borderLeft: "2px solid var(--c-tool)" }}>{fmtArgs(tc.arguments)}</pre>
            </div>
          ))}
        </div>
      )
    }
  }

  // Fallback: pretty-printed JSON.
  return <pre style={PRE_BASE}>{JSON.stringify(e.data, null, 2)}</pre>
}

// ---------------------------------------------------------------------------
// fmt
// ---------------------------------------------------------------------------

function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 23)
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const dy = String(d.getDate()).padStart(2, "0")
  const h  = String(d.getHours()).padStart(2, "0")
  const m  = String(d.getMinutes()).padStart(2, "0")
  const s  = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  // Only prefix the date when it differs from today
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate()
  return sameDay ? `${h}:${m}:${s}.${ms}` : `${mo}-${dy} ${h}:${m}:${s}`
}

// ---------------------------------------------------------------------------
// HistModal — date-range picker for deep DB history search
// ---------------------------------------------------------------------------

type HistPresetOption = "24h" | "48h" | "7d" | "30d" | "custom"

const HIST_OPTIONS: { value: HistPresetOption; label: string }[] = [
  { value: "24h",    label: "Last 24 hours" },
  { value: "48h",    label: "Last 48 hours" },
  { value: "7d",     label: "Last 7 days" },
  { value: "30d",    label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
]

function HistModal({
  preset,
  customFrom,
  customTo,
  onConfirm,
  onCancel,
}: {
  preset: HistPresetOption
  customFrom: string
  customTo: string
  onConfirm: (preset: HistPresetOption, from: string, to: string) => void
  onCancel: () => void
}) {
  const [sel, setSel] = useState(preset)
  const [from, setFrom] = useState(customFrom)
  const [to, setTo] = useState(customTo)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus trap + keyboard nav
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  function confirm() {
    if (sel === "custom" && !from) return  // require from date
    onConfirm(sel, from, to)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return }
    if (e.key === "Enter") { confirm(); return }
    if (e.key === "ArrowDown") {
      const idx = HIST_OPTIONS.findIndex((o) => o.value === sel)
      setSel(HIST_OPTIONS[Math.min(idx + 1, HIST_OPTIONS.length - 1)].value)
    }
    if (e.key === "ArrowUp") {
      const idx = HIST_OPTIONS.findIndex((o) => o.value === sel)
      setSel(HIST_OPTIONS[Math.max(idx - 1, 0)].value)
    }
  }

  return (
    // Backdrop
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKey}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--divider-strong)",
          borderRadius: 6,
          padding: "20px 24px",
          minWidth: 300,
          outline: "none",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-sm)",
        }}
      >
        <div style={{ color: "var(--fg)", fontWeight: 600, marginBottom: 14, letterSpacing: "0.06em" }}>
          HISTORY DEPTH
        </div>

        {HIST_OPTIONS.map((opt) => (
          <div
            key={opt.value}
            onClick={() => setSel(opt.value)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "4px 0", cursor: "pointer",
              color: sel === opt.value ? "var(--fg)" : "var(--fg-dim)",
            }}
          >
            <span style={{ color: sel === opt.value ? "var(--accent)" : "var(--fg-mute)", width: 14 }}>
              {sel === opt.value ? "●" : "○"}
            </span>
            <span>{opt.label}</span>
            {sel === opt.value && (
              <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>↵</span>
            )}
          </div>
        ))}

        {sel === "custom" && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>from (ISO or date)</div>
            <input
              autoFocus
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="2026-05-01T00:00:00"
              style={{ color: "var(--fg)", fontSize: "var(--fs-sm)", padding: "4px 8px", background: "var(--bg-soft)", border: "1px solid var(--divider-strong)", borderRadius: 3 }}
            />
            <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>to (leave blank for now)</div>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="2026-05-03T23:59:59"
              style={{ color: "var(--fg)", fontSize: "var(--fs-sm)", padding: "4px 8px", background: "var(--bg-soft)", border: "1px solid var(--divider-strong)", borderRadius: 3 }}
            />
          </div>
        )}

        <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={confirm}
            style={{
              flex: 1,
              padding: "6px 0",
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              fontSize: "var(--fs-sm)",
              letterSpacing: "0.06em",
            }}
          >load history</button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "6px 14px",
              color: "var(--fg-dim)",
              border: "1px solid var(--divider-strong)",
              borderRadius: 3,
              cursor: "pointer",
              fontSize: "var(--fs-sm)",
            }}
          >cancel</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const LogPane = forwardRef<LogPaneHandle, Props>(function LogPane(
  { active, events, activeRunId },
  ref,
) {
  const [filter, setFilter] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [followRun, setFollowRun] = useState(false)

  // ── Hist mode ─────────────────────────────────────────────────
  // "hist" queries the full SQLite event_log with a user-chosen date range.
  // It is NEVER fired automatically — only when the user explicitly opens the
  // modal and confirms a range. When the filter changes while hist is active,
  // a debounced re-query runs with the same range.
  const [histMode, setHistMode] = useState(false)
  const [histModal, setHistModal] = useState(false)
  const [histPreset, setHistPreset] = useState<HistPresetOption>("24h")
  const [histCustomFrom, setHistCustomFrom] = useState("")
  const [histCustomTo, setHistCustomTo] = useState("")
  const [histResults, setHistResults] = useState<WsEvent[]>([])
  const [histSearching, setHistSearching] = useState(false)
  const histTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stick-to-bottom: starts on. Turns off the moment the user scrolls up,
  // turns back on when they scroll back to (within 32px of) the bottom.
  // Mirrors `tail -f` and every modern terminal.
  const [stickBottom, setStickBottom] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focusFilter: () => inputRef.current?.focus(),
    clearFilter: () => setFilter(""),
    jumpToBottom: () => jumpToBottom(),
    toggleFollow: () => setFollowRun((v) => !v),
    focusScroll: () => scrollRef.current?.focus(),
  }))

  const parsed = useMemo(() => {
    let p = parseFilter(filter)
    if (followRun && activeRunId && !(p.include.runs && p.include.runs.length)) {
      p = { ...p, include: { ...p.include, runs: [activeRunId] } }
    }
    return p
  }, [filter, followRun, activeRunId])

  const visible = useMemo(() => {
    // Filter the entire buffer, then sort by timestamp so the rendered order
    // is always chronological regardless of push order. The cap keeps the
    // most-recent 800 matched events (sort first, then slice the tail).
    const out: WsEvent[] = []
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!
      if (matches(ev, parsed)) out.push(ev)
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    return out.length > 800 ? out.slice(out.length - 800) : out
  }, [events, parsed])

  // Auto-scroll the pane to the bottom whenever new rows arrive AND the user
  // hasn't scrolled away. Runs after layout so we measure the freshly grown
  // list height. We use direct DOM mutation rather than scrollIntoView to
  // avoid focus-stealing.
  useEffect(() => {
    if (!stickBottom) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [visible.length, stickBottom])

  // ── Hist search ───────────────────────────────────────────────
  function presetAfter(preset: HistPresetOption, customFrom: string): string {
    if (preset === "custom") return customFrom
    const offsets: Record<string, number> = { "24h": 864e5, "48h": 1728e5, "7d": 6048e5, "30d": 25920e5 }
    return new Date(Date.now() - (offsets[preset] ?? 864e5)).toISOString()
  }

  // Translate all structured filter tokens into DB-queryable params.
  // The DB returns a superset; client-side matches() does the final exact pass.
  // This prevents the 1000-row cap silently dropping results for type:X,
  // group:X, run:X etc. when hist mode is active.
  function buildHistParams(p: ParsedFilter): { q: string; type_patterns?: string[] } {
    const patterns: string[] = []

    // err:1 → look for these substrings in the type column
    if (p.err) patterns.push("failed", "error", "cancelled")

    // type:X → already are type substrings, forward directly
    if (p.include.types?.length) patterns.push(...p.include.types)

    // group:X → expand to approximate type prefixes that map to each category
    if (p.include.kinds?.length) {
      for (const k of p.include.kinds) {
        switch (k) {
          case "run":    patterns.push("run."); break
          case "step":   patterns.push("step.", "tool_call."); break
          case "agent":  patterns.push("agent.", "llm.", "debug.trace"); break
          case "tool":   patterns.push("tool.", "tool_"); break
          case "sync":   patterns.push("sync."); break
          case "audit":  patterns.push("audit."); break
          case "debug":  patterns.push("debug.", "delegation.", "checkpoint."); break
          case "error":  patterns.push("failed", "error", "cancelled"); break
          // "system" has no type prefix — let client filter on the returned rows
        }
      }
    }

    // q: freetext first; fall back to first run prefix so run-scoped queries
    // hit the DB rather than relying on client-side filtering against a capped result set.
    // For multiple run: tokens the first is most specific; client-side handles the rest.
    const q = p.text || (p.include.runs?.[0] ?? "")

    return { q, type_patterns: patterns.length ? patterns : undefined }
  }

  const runHistQuery = useCallback(async (
    p: typeof parsed,
    preset: HistPresetOption,
    customFrom: string,
    customTo: string,
  ) => {
    setHistSearching(true)
    try {
      const after = presetAfter(preset, customFrom)
      const before = preset === "custom" && customTo ? customTo : undefined
      const { q, type_patterns } = buildHistParams(p)
      const { events: rows } = await api.searchEvents(q, {
        type_patterns,
        limit: 1000,
        after,
        before,
      })
      setHistResults(rows)
    } catch { setHistResults([]) }
    finally { setHistSearching(false) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Re-query (debounced) when filter changes while hist is active
  useEffect(() => {
    if (!histMode) return
    if (histTimerRef.current) clearTimeout(histTimerRef.current)
    histTimerRef.current = setTimeout(() => {
      void runHistQuery(parsed, histPreset, histCustomFrom, histCustomTo)
    }, 400)
    return () => { if (histTimerRef.current) clearTimeout(histTimerRef.current) }
  }, [parsed, histMode, histPreset, histCustomFrom, histCustomTo, runHistQuery])

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distFromBottom < 32
    if (atBottom !== stickBottom) setStickBottom(atBottom)
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setStickBottom(true)
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Stable dedup key — type + timestamp + runId + seq is unique enough.
  // WsEvent has no numeric id, so we cannot rely on it.
  function evKey(e: WsEvent) {
    return `${e.type}|${e.timestamp}|${String(e.data["runId"] ?? "")}|${String(e.data["seq"] ?? "")}`
  }

  // Merge in-memory visible + hist results (deduplicated, chronological)
  const allVisible = useMemo(() => {
    if (!histMode || !histResults.length) return visible
    const seen = new Set(visible.map(evKey))
    const extra = histResults.filter((e) => matches(e, parsed) && !seen.has(evKey(e)))
    return [...visible, ...extra].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [visible, histMode, histResults, parsed])

  return (<>
    <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <PaneHeader active={active} title="OPERATIONS"
        hint={histMode
          ? `${allVisible.length} (live+hist${histSearching ? " …" : ` ${histResults.length}`})`
          : `${visible.length}/${events.length}`}
        hotkey="Ctrl+2" />

      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          borderBottom: "1px solid var(--divider)",
          background: "var(--bg-input)",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--accent)", fontSize: "var(--fs-base)" }}>/</span>
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="type:api.request  -type:events  group:agent  run:a3f9c  err:1  freetext…"
          spellCheck={false}
          style={{ flex: 1, color: "var(--fg)", fontSize: "var(--fs-base)" }}
        />
        {/* HIST — deep query against full SQLite event log */}
        <button
          type="button"
          onClick={() => {
            if (histMode) {
              // Toggle off: clear results
              setHistMode(false)
              setHistResults([])
            } else {
              setHistModal(true)
            }
          }}
          title={histMode ? "Showing full DB history — click to exit hist mode" : "Search full event history (DB query)"}
          style={{
            color: histMode ? "var(--accent)" : "var(--fg-mute)",
            fontSize: "var(--fs-xs)",
            letterSpacing: "0.06em",
            padding: "3px 8px",
            border: `1px solid ${histMode ? "var(--accent)" : "var(--divider-strong)"}`,
            borderRadius: 3,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {histMode ? "[x] hist" : "[ ] hist"}
        </button>
        <button
          type="button"
          onClick={() => setFollowRun((v) => !v)}
          title={followRun ? "Showing only active run — click to show all" : "Follow active run only"}
          style={{
            color: followRun ? "var(--accent)" : "var(--fg-dim)",
            fontSize: "var(--fs-xs)",
            letterSpacing: "0.06em",
            padding: "3px 8px",
            border: "1px solid var(--divider-strong)",
            borderRadius: 3,
            cursor: "pointer",
          }}
        >
          {followRun ? "[x] follow" : "[ ] follow"}
        </button>
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            style={{ color: "var(--fg-mute)", fontSize: "var(--fs-sm)", cursor: "pointer", padding: "2px 6px" }}
            title="Clear filter"
          >x</button>
        ) : null}
      </div>

      {/* Hist banner */}
      {histMode && (
        <div style={{
          padding: "3px 14px",
          background: "color-mix(in srgb, var(--accent) 8%, transparent)",
          borderBottom: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
          fontSize: "var(--fs-xs)",
          color: "var(--fg-mute)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          alignItems: "center",
          flexShrink: 0,
        }}>
          <button type="button" onClick={() => setHistModal(true)}
            style={{ color: "var(--accent)", fontSize: "var(--fs-xs)", cursor: "pointer", background: "none", border: "none", padding: 0 }}
          >[{histPreset}]</button>
          <span style={{ color: "var(--fg-mute)" }}>·</span>
          <span style={{ color: "var(--fg-mute)" }}>fetched {histSearching ? "…" : histResults.length} rows</span>
        </div>
      )}

      {/* Rows */}
      <div ref={scrollRef} onScroll={onScroll} tabIndex={-1} style={{ flex: 1, overflow: "auto", position: "relative", outline: "none" }}>
        {allVisible.length === 0 ? (
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-sm)", padding: "8px 14px" }}>
            no events match.
          </div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
            {allVisible.map((e, i) => {
              const cat = categoryFor(e)
              const typeLabel = effectiveType(e)
              const isOk = typeLabel === "run.completed" || /\.ok$|\.success$/i.test(typeLabel)
              const accentColor = isOk ? "var(--c-ok)" : CAT_COLOR[cat]
              const key = `${typeLabel}:${e.timestamp}:${e.data["runId"] ?? ""}:${i}`
              const open = expanded.has(key)
              const summary = summarize(e)
              const runId = e.data["runId"] as string | undefined
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      display: "grid",
                      gridTemplateColumns: "96px 70px 200px 1fr",
                      gap: 12,
                      padding: "2px 14px",
                      lineHeight: "1.55",
                      cursor: "pointer",
                      borderLeft: `2px solid ${accentColor}`,
                      color: "var(--fg)",
                      fontSize: "var(--fs-sm)",
                    }}
                    onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = "var(--bg-soft)" }}
                    onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = "transparent" }}
                  >
                    <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
                      {fmtClock(e.timestamp)}
                    </span>
                    <span style={{ color: accentColor, fontSize: "var(--fs-xs)", letterSpacing: "0.04em" }}>
                      {cat}
                    </span>
                    <span style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {typeLabel}
                    </span>
                    <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {runId ? <span style={{ color: "var(--fg-mute)", marginRight: 8 }}>{runId.slice(0, 7)}</span> : null}
                      {summary || <span style={{ color: "var(--fg-mute)" }}>—</span>}
                    </span>
                  </button>
                  {open ? (
                    <div
                      style={{
                        margin: "2px 12px 10px 14px",
                        padding: "8px 10px",
                        background: "var(--bg-soft)",
                        borderLeft: `2px solid ${accentColor}`,
                      }}
                    >
                      <ExpandedDetail e={e} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
        {!stickBottom ? (
          <button
            type="button"
            onClick={jumpToBottom}
            title="Jump to newest (resume tail)"
            style={{
              position: "sticky",
              bottom: 8,
              marginLeft: "auto",
              marginRight: 14,
              display: "block",
              transform: "translateY(0)",
              padding: "4px 10px",
              fontSize: "var(--fs-xs)",
              letterSpacing: "0.04em",
              color: "var(--accent)",
              background: "var(--bg-elev)",
              border: "1px solid var(--accent-soft, var(--divider-strong))",
              borderRadius: 3,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            ↓ jump to newest
          </button>
        ) : null}
      </div>
    </section>

    {/* ── Hist range modal ─────────────────────────────────── */}
    {histModal && (
      <HistModal
        preset={histPreset}
        customFrom={histCustomFrom}
        customTo={histCustomTo}
        onConfirm={(preset, from, to) => {
          setHistPreset(preset)
          setHistCustomFrom(from)
          setHistCustomTo(to)
          setHistMode(true)
          setHistModal(false)
          void runHistQuery(parsed, preset, from, to)
        }}
        onCancel={() => setHistModal(false)}
      />
    )}
  </>)
})
