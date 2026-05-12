// =============================================================================
// ui-term — complete source bundle
// Generated: 2026-05-03T15:51:53Z
// =============================================================================

// =============================================================================
// EXTERNAL: Google Fonts (loaded via index.html <link>)
// https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap
// =============================================================================

// =============================================================================
// FILE: types.ts
// =============================================================================

/**
 * Slim type contract — only what term UI actually renders.
 * Mirrors `packages/ui/src/types.ts` for the subset we use.
 */

export interface Run {
  id: string
  goal: string
  status: string
  answer: string | null
  stepCount: number
  error: string | null
  createdAt: string
  completedAt: string | null
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
}

export interface RunDetail extends Run {
  data: { steps: Step[]; [k: string]: unknown }
  audit: AuditEntry[]
  logs: LogEntry[]
}

export interface Step {
  id: string
  name: string
  action: string
  status: string
  order: number
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface AuditEntry {
  actor: string
  action: string
  detail: Record<string, unknown>
  timestamp: string
}

export interface LogEntry {
  type: string
  error?: boolean
  message: string
  timestamp: string
  eventName?: string
  data?: Record<string, unknown>
}

export interface Me {
  sessionId: string
  displayName: string
  upn: string | null
  isAdmin: boolean
}

/** Raw SSE event envelope — what `/api/events/stream` emits. */
export interface WsEvent {
  type: string
  data: Record<string, unknown>
  timestamp: string
}

// =============================================================================
// FILE: api.ts
// =============================================================================

/**
 * Slim API client + SSE stream for the term UI.
 *
 * Same backend, same wire contract as the classic UI — we just don't
 * import the kitchen-sink (force-graphs, layouts, sync-recipes, …).
 */

import type { LogEntry, Me, Run, RunDetail, WsEvent } from "./types"

const BASE = ""

async function json<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) }
  if (opts?.body) headers["Content-Type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: "include" })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg = body && typeof body === "object" && "error" in body
      ? (body as { error: string }).error
      : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  // identity
  me:           () => json<Me>("/api/me"),
  setMe:        (displayName: string, upn: string) =>
    json<Me>("/api/me", { method: "POST", body: JSON.stringify({ displayName, upn }) }),
  clearMe:      () => json<{ ok: boolean }>("/api/me/clear", { method: "POST" }),

  // runs
  listRuns:     () => json<Run[]>("/api/runs"),
  getRun:       (id: string) => json<RunDetail>(`/api/runs/${id}`),
  startRun:     (goal: string, agentId?: string) =>
    json<{ runId: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ goal, ...(agentId ? { agentId } : {}) }),
    }),
  cancelRun:    (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  rerunRun:     (id: string) => json<{ runId: string }>(`/api/runs/${id}/rerun`, { method: "POST" }),
  respondToRun: (id: string, response: string) =>
    json<{ ok: boolean }>(`/api/runs/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),

  // rollback — reverts effects (filesystem changes, db writes, etc.) of a finished run
  previewRollback: (runId: string) =>
    json<{ effects?: Array<{ kind: string; target: string }>; effectCount?: number }>(
      `/api/effects/${encodeURIComponent(runId)}/rollback-preview`,
    ),
  rollbackRun:    (runId: string) =>
    json<{ ok: boolean; reverted?: number }>(
      `/api/effects/${encodeURIComponent(runId)}/rollback`,
      { method: "POST" },
    ),

  // trace export
  getRunTrace:  (id: string) => json<Record<string, unknown>[]>(`/api/runs/${id}/trace`).catch(() => [] as Record<string, unknown>[]),

  // answer quality feedback
  flagAnswer:   (id: string, note?: string) =>
    json<{ ok: boolean; action: string }>(`/api/runs/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useful: false, note }),
    }).catch(() => ({ ok: false, action: "error" })),

  // event log
  health:       () => json<{ status: string; active: number }>("/api/health"),
  recentEvents: (limit = 200) => json<{ events: WsEvent[] }>(`/api/events?limit=${limit}`).catch(() => ({ events: [] as WsEvent[] })),

  // notifications (read-only here; only used to surface errors)
  listLogs:     (runId: string) => json<{ logs: LogEntry[] }>(`/api/runs/${runId}/logs`).catch(() => ({ logs: [] as LogEntry[] })),
}

// ── SSE event stream ────────────────────────────────────────────

/**
 * Open the long-lived SSE stream and pipe envelopes through `onEvent`.
 * Browser auto-reconnects; we only need to surface connected/disconnected.
 */
export function createEventStream(
  onEvent: (e: WsEvent) => void,
  onStatus: (connected: boolean) => void,
): { close: () => void } {
  const url = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/events/stream`

  let alive = true
  let es: EventSource | null = null

  const seen = new Set<string>()
  function key(e: WsEvent): string {
    const seq = e.data["seq"] ?? ""
    const kind = e.type === "debug.trace"
      ? ((e.data["entry"] as Record<string, unknown> | undefined)?.["kind"] ?? "")
      : ""
    return `${e.type}:${e.timestamp}:${e.data["runId"] ?? ""}:${e.data["stepId"] ?? ""}:${kind}:${seq}`
  }

  function dedupe(e: WsEvent): boolean {
    const k = key(e)
    if (seen.has(k)) return false
    seen.add(k)
    if (seen.size > 600) {
      const arr = [...seen].slice(-300)
      seen.clear()
      arr.forEach((x) => seen.add(x))
    }
    return true
  }

  function connect() {
    if (!alive) return
    es = new EventSource(url, { withCredentials: true })
    es.onopen = () => onStatus(true)
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data as string) as WsEvent
        if (dedupe(env)) onEvent(env)
      } catch { /* ignore malformed */ }
    }
    es.onerror = () => {
      onStatus(false)
      if (!alive) es?.close()
    }
  }

  connect()

  return {
    close() {
      alive = false
      es?.close()
    },
  }
}

// =============================================================================
// FILE: store.ts
// =============================================================================

/**
 * Term-UI store — small zustand atom focused on what the two-pane shell
 * actually renders.
 *
 *  - `events` is the unified operations log. Every SSE envelope flows in
 *    here, deduped & capped at MAX_EVENTS. The right-pane filter slices
 *    over this single buffer.
 *  - `transcript` is what the LEFT pane shows for the active run: an
 *    ordered list of human-readable rows derived from the same events,
 *    filtered to the active runId.
 *  - `streaming` is the live LLM answer being typed in token-by-token.
 *  - `pendingInput` mirrors classic UI's ask_user contract.
 */

import { create } from "zustand"
import type { Run, WsEvent } from "./types"

const MAX_EVENTS = 5000

export type TranscriptKind =
  | "goal"
  | "thinking"
  | "tool"
  | "tool-result"
  | "tool-error"
  | "answer"
  | "error"
  | "user-input"
  | "info"

export interface TranscriptRow {
  id: string
  runId: string
  kind: TranscriptKind
  text: string
  meta?: string         // small right-aligned tag (e.g. "12ms", "47 tk")
  timestamp: string
  toolCallId?: string   // correlates tool_call.executing ↔ tool_call.completed for parallel calls
}

interface State {
  connected: boolean
  setConnected: (v: boolean) => void

  runs: Run[]
  activeRunId: string | null
  setRuns: (r: Run[]) => void
  setActiveRun: (id: string | null) => void
  upsertRun: (r: Partial<Run> & { id: string }) => void

  events: WsEvent[]
  transcript: TranscriptRow[]
  streamingAnswer: string

  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null

  pushEvent: (e: WsEvent) => void
  clearStream: () => void
  resetTranscript: (runId: string | null) => void
  clearPendingInput: () => void
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  setConnected: (v) => set({ connected: v }),

  runs: [],
  activeRunId: null,
  setRuns: (runs) => set({ runs }),
  setActiveRun: (id) => set({ activeRunId: id }),
  upsertRun: (r) => set((s) => {
    const idx = s.runs.findIndex((x) => x.id === r.id)
    if (idx === -1) {
      return { runs: [{ ...emptyRun(r.id), ...r } as Run, ...s.runs] }
    }
    const next = [...s.runs]
    next[idx] = { ...next[idx], ...r } as Run
    return { runs: next }
  }),

  events: [],
  transcript: [],
  streamingAnswer: "",
  pendingInput: null,

  pushEvent: (e) => {
    const state = get()

    // Always append to the unified ops log (capped).
    const events = state.events.length >= MAX_EVENTS
      ? [...state.events.slice(-MAX_EVENTS + 1), e]
      : [...state.events, e]

    const patch: Partial<State> = { events }

    // Maintain `runs` for run lifecycle events
    if (e.type === "run.queued") {
      // run.queued is the ONLY event that carries the goal text on the wire.
      // Store the run immediately so that run.started (which has no goal) can
      // fall back to state.runs to retrieve it.
      const id = String(e.data["runId"] ?? "")
      const goal = String(e.data["goal"] ?? "")
      if (id && !state.runs.find((r) => r.id === id)) {
        patch.runs = [emptyRun(id, goal, "pending", e.timestamp), ...state.runs]
      }
      if (!state.activeRunId) patch.activeRunId = id
    } else if (e.type === "run.started") {
      const id = String(e.data["runId"] ?? "")
      const goal = String(e.data["goal"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        const base: Run = idx === -1
          ? emptyRun(id, goal, "running", e.timestamp)
          : { ...state.runs[idx]!, status: "running" }
        const next = idx === -1 ? [base, ...state.runs] : (() => { const n = [...state.runs]; n[idx] = base; return n })()
        patch.runs = next
        // Auto-focus newly started run if nothing focused.
        if (!state.activeRunId) patch.activeRunId = id
      }
    } else if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") {
      const id = String(e.data["runId"] ?? "")
      if (id) {
        const idx = state.runs.findIndex((r) => r.id === id)
        if (idx !== -1) {
          const status = e.type === "run.completed" ? "completed"
            : e.type === "run.failed" ? "failed"
            : "cancelled"
          const next = [...state.runs]
          next[idx] = {
            ...next[idx]!,
            status,
            answer: (e.data["answer"] as string | undefined) ?? next[idx]!.answer,
            error:  (e.data["error"]  as string | undefined) ?? next[idx]!.error,
            completedAt: e.timestamp,
          }
          patch.runs = next
        }
      }
    } else if (e.type === "answer.chunk" || e.type === "agent.chunk") {
      // Streaming LLM output for the active run. The orchestrator emits
      // `answer.chunk` per token via Agent.onToken; `agent.chunk` is kept
      // as an alias for any older/parallel emitters.
      const runId = String(e.data["runId"] ?? "")
      if (runId === state.activeRunId) {
        const chunk = String(e.data["chunk"] ?? "")
        if (chunk) patch.streamingAnswer = state.streamingAnswer + chunk
      }
    }

    // Build transcript row if relevant for active run.
    // Use patch.activeRunId when available — run.started sets patch.activeRunId
    // in the same tick, before set() is called, so state.activeRunId is still
    // the old value (null or previous run). Without this, the goal row and the
    // first few tool rows for a brand-new run are always dropped.
    const effectiveActiveRunId = (patch.activeRunId as string | null | undefined) ?? state.activeRunId
    const row = toTranscriptRow(e, state)
    if (row && row.runId === effectiveActiveRunId) {
      // De-dupe goal: server replays `run.started` from both the
      // global event backlog and the per-run log hydration, so the
      // same row would appear twice. Only keep the first.
      const isDupGoal = row.kind === "goal" &&
        state.transcript.some((r) => r.kind === "goal" && r.runId === row.runId)
      if (!isDupGoal) {
        patch.transcript = [...state.transcript, row]
      }
      // Reset stream once final answer arrives
      if (row.kind === "answer" || row.kind === "error") patch.streamingAnswer = ""
    }

    // ask_user prompt — server sends user_input.required; older paths use agent.ask_user / tool.ask_user
    if (e.type === "agent.ask_user" || e.type === "tool.ask_user" || e.type === "user_input.required") {
      const runId = String(e.data["runId"] ?? "")
      const question = String(e.data["question"] ?? "")
      if (runId && question) {
        patch.pendingInput = {
          runId,
          question,
          options: e.data["options"] as string[] | undefined,
          sensitive: !!e.data["sensitive"],
        }
      }
    }

    set(patch)
  },

  clearStream: () => set({ streamingAnswer: "" }),
  resetTranscript: (runId) => set({ transcript: [], streamingAnswer: "", activeRunId: runId }),
  clearPendingInput: () => set({ pendingInput: null }),
}))

// ── helpers ──────────────────────────────────────────────────────

function emptyRun(id: string, goal = "", status = "pending", createdAt = new Date().toISOString()): Run {
  return {
    id, goal, status, answer: null, stepCount: 0, error: null,
    createdAt, completedAt: null,
    totalTokens: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0,
  }
}

function toTranscriptRow(e: WsEvent, state?: State): TranscriptRow | null {
  const runId = String(e.data["runId"] ?? "")
  if (!runId) return null
  const id = `${e.type}:${e.timestamp}:${e.data["seq"] ?? Math.random()}`
  const ts = e.timestamp

  switch (e.type) {
    case "run.started": {
      // run.started has no goal in the payload — look it up from state.runs,
      // which run.queued already populated.
      const goal = String(
        e.data["goal"] ??
        state?.runs.find((r) => r.id === runId)?.goal ??
        "",
      )
      return { id, runId, kind: "goal", text: goal, timestamp: ts }
    }
    case "agent.thinking":
      // server sends `content`, not `text` (run-executor.ts broadcasts { content: entry.text })
      return { id, runId, kind: "thinking", text: String(e.data["content"] ?? e.data["text"] ?? "thinking…"), timestamp: ts }
    case "tool.call":
    case "agent.tool_call":
    case "step.started":
    case "tool_call.executing": {
      const tool = String(e.data["tool"] ?? e.data["toolName"] ?? e.data["action"] ?? e.data["name"] ?? "tool")
      const args = e.data["argsSummary"] ?? e.data["input"] ?? e.data["args"] ?? ""
      const a = typeof args === "string" ? args : JSON.stringify(args)
      const toolCallId = e.data["toolCallId"] ? String(e.data["toolCallId"]) : undefined
      return { id, runId, kind: "tool", text: `${tool}  ${a}`.trim(), timestamp: ts, toolCallId }
    }
    case "tool.result":
    case "agent.tool_result":
    case "step.completed":
    case "tool_call.completed": {
      const tool = String(e.data["tool"] ?? e.data["toolName"] ?? e.data["action"] ?? e.data["name"] ?? "")
      const out = e.data["output"] as Record<string, unknown> | undefined
      const summary = String(
        e.data["summary"] ??
        e.data["text"] ??
        (out && typeof out["result"] === "string" ? out["result"] : "") ??
        "",
      )
      const ms = e.data["durationMs"] as number | undefined
      const toolCallId = e.data["toolCallId"] ? String(e.data["toolCallId"]) : undefined
      return {
        id, runId, kind: "tool-result",
        text: summary || (tool ? `↳ ${tool} ok` : "↳ ok"),
        meta: ms != null ? `${ms}ms` : undefined,
        timestamp: ts,
        toolCallId,
      }
    }
    case "tool.error":
    case "agent.tool_error":
    case "step.failed":
      return { id, runId, kind: "tool-error", text: String(e.data["error"] ?? e.data["text"] ?? ""), timestamp: ts }
    // ── Planner activity rows ────────────────────────────────────────────────
    // These keep the transcript alive during planner runs (which are otherwise
    // silent because child-agent step events carry child runIds, not parent's).
    case "planner.started":
      return { id, runId, kind: "thinking", text: `planning… route=${String(e.data["route"] ?? "?")} score=${String(e.data["score"] ?? "?")}`, timestamp: ts }
    case "planner.step.started":
      return { id, runId, kind: "tool", text: `step: ${String(e.data["stepName"] ?? "?")}  (${String(e.data["stepType"] ?? "delegate")})`, timestamp: ts }
    case "planner.step.completed": {
      const stepStatus = String(e.data["status"] ?? "done")
      const stepMs = e.data["durationMs"] as number | undefined
      return { id, runId, kind: "tool-result", text: `↳ ${String(e.data["stepName"] ?? "step")} → ${stepStatus}`, meta: stepMs != null ? `${stepMs}ms` : undefined, timestamp: ts }
    }
    case "delegation.started":
    case "planner.delegation.started":
      return { id, runId, kind: "thinking", text: `→ delegating: ${String(e.data["agentName"] ?? e.data["stepName"] ?? "child")} (depth ${String(e.data["depth"] ?? "?")})`, timestamp: ts }
    case "delegation.ended": {
      const delStatus = String(e.data["status"] ?? "done")
      const delErr = e.data["error"] ? ` — ${String(e.data["error"]).slice(0, 80)}` : ""
      const delKind: TranscriptKind = (e.data["status"] === "failed" || e.data["error"]) ? "tool-error" : "tool-result"
      return { id, runId, kind: delKind, text: `← ${delStatus}${delErr}`.trim(), timestamp: ts }
    }
    case "run.completed":
      return { id, runId, kind: "answer", text: String(e.data["answer"] ?? ""), timestamp: ts }
    case "run.failed":
      return { id, runId, kind: "error", text: String(e.data["error"] ?? "failed"), timestamp: ts }
    case "agent.ask_user":
    case "tool.ask_user":
      return { id, runId, kind: "user-input", text: String(e.data["question"] ?? ""), timestamp: ts }
    default:
      return null
  }
}

// =============================================================================
// FILE: uiPref.ts
// =============================================================================

/**
 * UI shell preference — persists which UI the user wants to boot into.
 *
 * Both the classic dashboard and the term UI read this on mount and offer
 * a small switcher chip (top-right). Switching just re-targets the
 * browser to the other shell's URL/port.
 */

const KEY = "agent001:ui"
export type UIShell = "classic" | "term"

export function getUiShell(): UIShell {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === "term" ? "term" : "classic"
  } catch { return "classic" }
}

export function setUiShell(s: UIShell): void {
  try { window.localStorage.setItem(KEY, s) } catch { /* ignore */ }
}

/**
 * Resolve the URL of the OTHER shell, factoring in dev port or production
 * sub-path. In dev, classic = :5179 and term = :5180. In prod, both ship
 * from the same origin and we just append `?ui=…` so a tiny boot page
 * can pick the right bundle.
 */
export function urlForShell(target: UIShell): string {
  const { protocol, hostname, port, pathname } = window.location
  // dev: known port pair
  if (port === "5179" && target === "term")    return `${protocol}//${hostname}:5180${pathname}`
  if (port === "5180" && target === "classic") return `${protocol}//${hostname}:5179${pathname}`
  // prod: same origin, query flag
  const base = `${protocol}//${hostname}${port ? ":" + port : ""}${pathname}`
  return `${base}?ui=${target}`
}

// =============================================================================
// FILE: keybinds.ts
// =============================================================================

/**
 * Lightweight global keybind dispatcher.
 *
 * Linux/vim-style: Ctrl is the universal modifier on every platform
 * (no Cmd magic, no glyphs). Bindings are spelled `Ctrl+<key>` in
 * the help bar and `ev.ctrlKey` in code.
 *
 * Conventions:
 *   Ctrl+1 / Ctrl+2   focus stream / log pane
 *   Ctrl+R            open run picker
 *   Ctrl+F            focus log filter
 *   Ctrl+I            focus goal input
 *   Ctrl+L            clear log filter
 *   Esc               blur active input
 *
 * Slash commands (typed in the prompt):
 *   /admin            open admin login
 *   /runs             open run picker
 *   /logs             focus log pane
 *   /stream           focus stream pane
 *   /quit             sign out / switch user
 */

import { useEffect } from "react"

export type KeybindHandler = (key: string, ev: KeyboardEvent) => boolean | void

export function useGlobalKeybinds(handler: KeybindHandler): void {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const handled = handler(ev.key, ev)
      if (handled) ev.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [handler])
}

/** Universal modifier check — Ctrl on all platforms (linux convention). */
export function isMeta(ev: KeyboardEvent): boolean {
  return ev.ctrlKey
}

/** Plain-text label for the meta key (used by HelpBar). */
export const META_LABEL = "Ctrl"

// =============================================================================
// FILE: commands.ts
// =============================================================================

/**
 * Command registry — single source of truth for every action the user can
 * invoke in the term UI.
 *
 * One definition serves four surfaces:
 *   1. CommandPalette  (Ctrl+K / ?)        — fuzzy-filterable menu
 *   2. Slash dispatcher (typed in prompt)  — `/cancel`, `/runs`, …
 *   3. Global keybinds (handleKey)         — `Ctrl+1`, `Ctrl+.`, …
 *   4. HelpBar footer hints                — only items marked `pinned`
 *
 * Adding a new action means appending one entry here. The shell wires
 * itself up automatically.
 */

import { META_LABEL } from "./keybinds"

export type CommandGroup = "navigate" | "run" | "log" | "shell"

export interface CommandContext {
  /** True when an active run is currently running or pending. */
  busy: boolean
  /** Currently focused run id, if any. */
  activeRunId: string | null
  /** Are we currently being asked a question by the agent? */
  hasPendingInput: boolean
}

export interface Command {
  id: string
  label: string
  hint?: string
  group: CommandGroup
  /** Keybind label as shown to the user, e.g. "Ctrl+R". */
  keybind?: string
  /** Slash form typed in the prompt (lowercase, no leading "/"). Aliases supported via `slashAliases`. */
  slash?: string
  slashAliases?: string[]
  /** Surface in the slim HelpBar at the bottom. Keep ≤ 5. */
  pinned?: boolean
  /** Hide / disable when this returns false. */
  when?: (ctx: CommandContext) => boolean
  /** Action — invoked from any surface. May be async. */
  run: () => void | Promise<void>
}

/**
 * Build the command list. Wired in App.tsx with closures over its handlers
 * so each command captures the current state.
 */
export function buildCommands(deps: {
  ctx: CommandContext
  openPalette: () => void
  openRunPicker: () => void
  openAdmin: () => void
  focusStream: () => void
  focusLog: () => void
  focusFilter: () => void
  focusPrompt: () => void
  clearFilter: () => void
  abortRun: () => void
  rerunRun: () => Promise<void>
  rollbackRun: () => Promise<void>
  exportTrace: () => Promise<void>
  flagAnswer: () => Promise<void>
  followLog: () => void
  jumpToBottom: () => void
  switchUser: () => void
  switchUi: () => void
  toggleView: () => void
}): Command[] {
  const { ctx } = deps
  return [
    // ── NAVIGATE ──────────────────────────────────────────────
    {
      id: "focus.stream",
      label: "Focus stream pane",
      group: "navigate",
      keybind: `${META_LABEL}+1`,
      slash: "stream", slashAliases: ["s"],
      run: deps.focusStream,
    },
    {
      id: "focus.log",
      label: "Focus operations log",
      group: "navigate",
      keybind: `${META_LABEL}+2`,
      slash: "logs", slashAliases: ["l"],
      run: deps.focusLog,
    },
    {
      id: "focus.prompt",
      label: "Focus prompt",
      group: "navigate",
      keybind: `${META_LABEL}+I`,
      run: deps.focusPrompt,
    },
    {
      id: "focus.filter",
      label: "Focus log filter",
      group: "navigate",
      keybind: `${META_LABEL}+F`,
      run: deps.focusFilter,
    },
    {
      id: "filter.clear",
      label: "Clear log filter",
      group: "log",
      keybind: `${META_LABEL}+L`,
      run: deps.clearFilter,
    },
    {
      id: "log.follow",
      label: "Toggle follow active run",
      hint: "show only current run events",
      group: "log",
      keybind: `${META_LABEL}+G`,
      slash: "follow",
      run: deps.followLog,
    },
    {
      id: "log.bottom",
      label: "Jump to bottom",
      hint: "scroll to newest output",
      group: "log",
      keybind: `${META_LABEL}+End`,
      slash: "bottom",
      run: deps.jumpToBottom,
    },

    // ── RUN ───────────────────────────────────────────────────
    {
      id: "runs.picker",
      label: "Open run picker",
      hint: "list & switch runs",
      group: "run",
      keybind: `${META_LABEL}+R`,
      slash: "runs", slashAliases: ["r"],
      run: deps.openRunPicker,
    },
    {
      id: "run.abort",
      label: "Abort active run",
      hint: "send cancel signal",
      group: "run",
      keybind: `${META_LABEL}+.`,
      slash: "cancel", slashAliases: ["c", "abort"],
      pinned: true,
      when: (c) => c.busy,
      run: deps.abortRun,
    },
    {
      id: "run.rerun",
      label: "Re-run with same goal",
      group: "run",
      slash: "rerun",
      when: (c) => !!c.activeRunId,
      run: deps.rerunRun,
    },
    {
      id: "run.rollback",
      label: "Roll back run effects",
      hint: "revert filesystem & db writes",
      group: "run",
      slash: "rollback",
      when: (c) => !!c.activeRunId && !c.busy,
      run: deps.rollbackRun,
    },
    {
      id: "run.export",
      label: "Download trace as .txt",
      hint: "save agent-loop trace to file",
      group: "run",
      keybind: `${META_LABEL}+E`,
      slash: "export", slashAliases: ["download", "trace"],
      when: (c) => !!c.activeRunId,
      run: deps.exportTrace,
    },
    {
      id: "run.flag",
      label: "Flag answer as unhelpful",
      hint: "down-weight memory so agent avoids this approach next time",
      group: "run",
      slash: "flag", slashAliases: ["bad", "wrong"],
      when: (c) => !!c.activeRunId,
      run: deps.flagAnswer,
    },

    // ── SHELL ─────────────────────────────────────────────────
    {
      id: "shell.admin",
      label: "Sign in as admin",
      group: "shell",
      slash: "admin", slashAliases: ["a"],
      run: deps.openAdmin,
    },
    {
      id: "shell.switchUser",
      label: "Switch identity / sign out",
      group: "shell",
      slash: "quit", slashAliases: ["q"],
      run: deps.switchUser,
    },
    {
      id: "shell.switchUi",
      label: "Switch to classic UI",
      group: "shell",
      slash: "ui",
      run: deps.switchUi,
    },
    {
      id: "shell.toggleView",
      label: "Toggle visual / TUI mode",
      hint: "calm pipeline view vs log view",
      group: "shell",
      keybind: `${META_LABEL}+\\`,
      slash: "visual", slashAliases: ["vis", "view"],
      run: deps.toggleView,
    },
    {
      id: "shell.palette",
      label: "Show this menu",
      hint: "command palette",
      group: "shell",
      keybind: `${META_LABEL}+K`,
      pinned: true,
      run: deps.openPalette,
    },
  ].filter((cmd) => !cmd.when || cmd.when(ctx))
}

/**
 * Try to interpret `text` as a slash command. Returns the matched command
 * or null. Match is case-insensitive on the trimmed input.
 */
export function matchSlash(text: string, commands: Command[]): Command | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null
  const tail = trimmed.slice(1).toLowerCase()
  for (const cmd of commands) {
    if (cmd.slash === tail) return cmd
    if (cmd.slashAliases?.includes(tail)) return cmd
  }
  return null
}

/**
 * Slash autocomplete suggestions for the goal input.
 *
 * Input is the raw textarea contents. We only suggest when the user has
 * started a slash on the FIRST line — slashes mid-prose (e.g. paths) shouldn't
 * trigger the popup. Empty query (just "/") returns every slash command.
 *
 * Matching: prefix match on slash + slashAliases (case-insensitive). Prefix
 * matches rank above substring matches; aliases rank below their canonical
 * slash. Pinned commands win ties.
 */
export interface SlashSuggestion {
  slash: string         // canonical slash, no leading "/"
  alias?: string        // matched alias, if user typed an alias prefix
  label: string
  hint?: string
  keybind?: string
  group: CommandGroup
  run: () => void | Promise<void>
}

export function slashSuggestions(text: string, commands: Command[]): SlashSuggestion[] {
  // Only the first line — paste-multiline is fine, we just don't auto-complete
  // when the slash isn't the very first thing typed.
  const firstLine = text.split("\n")[0] ?? ""
  if (!firstLine.startsWith("/")) return []
  const query = firstLine.slice(1).toLowerCase().trim()

  type Scored = { sug: SlashSuggestion; score: number }
  const out: Scored[] = []

  for (const cmd of commands) {
    if (!cmd.slash) continue
    const candidates: { token: string; isAlias: boolean }[] = [{ token: cmd.slash, isAlias: false }]
    for (const a of cmd.slashAliases ?? []) candidates.push({ token: a, isAlias: true })

    let best = -1
    let bestAlias: string | undefined
    for (const { token, isAlias } of candidates) {
      let score = 0
      if (!query) score = 50                                      // empty query → list everything
      else if (token === query) score = 100                       // exact
      else if (token.startsWith(query)) score = 80 - token.length // prefix; shorter token wins
      else if (token.includes(query)) score = 40                  // substring (low)
      if (isAlias) score -= 5                                      // canonical wins ties
      if (score > best) { best = score; bestAlias = isAlias ? token : undefined }
    }

    if (best <= 0) continue
    if (cmd.pinned) best += 1
    out.push({
      sug: {
        slash: cmd.slash,
        alias: bestAlias,
        label: cmd.label,
        hint: cmd.hint,
        keybind: cmd.keybind,
        group: cmd.group,
        run: cmd.run,
      },
      score: best,
    })
  }

  out.sort((a, b) => b.score - a.score)
  return out.map((s) => s.sug)
}

/** Cheap fuzzy score: substring + initials. Higher = better. 0 = no match. */
export function fuzzyScore(query: string, label: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  if (l === q) return 100
  if (l.startsWith(q)) return 80
  if (l.includes(q)) return 60
  // Initials match: "fs" → "Focus stream"
  const initials = l.split(/[\s/-]+/).map((w) => w[0]).join("")
  if (initials.startsWith(q)) return 50
  // Subsequence
  let i = 0
  for (const ch of l) { if (ch === q[i]) i++; if (i === q.length) return 30 }
  return 0
}

// =============================================================================
// FILE: useMe.ts
// =============================================================================

/**
 * Identity hook — same contract as classic UI's useMe.
 */

import { useCallback, useEffect, useState } from "react"
import { api } from "./api"
import type { Me } from "./types"

export function useMe() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.me()
      setMe(data)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const setIdentity = useCallback(async (displayName: string, upn: string) => {
    const data = await api.setMe(displayName, upn)
    setMe(data)
    return data
  }, [])

  const switchUser = useCallback(async () => {
    await api.clearMe()
    await refresh()
  }, [refresh])

  const needsWelcome = !!me && me.displayName === "Anonymous" && me.upn === null

  return { me, loading, needsWelcome, refresh, setIdentity, switchUser }
}

// =============================================================================
// FILE: components/AdminLogin.tsx
// =============================================================================

/**
 * AdminLogin — fallback admin auth (Ctrl+Shift+A) when UPN whitelist
 * isn't available. Mirrors the contract from classic UI.
 */

import { useEffect, useRef, useState } from "react"

interface Props {
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}

export function AdminLogin({ onClose, onSubmit }: Props) {
  const [pw, setPw] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function submit() {
    if (!pw) { setErr("password required"); return }
    setBusy(true); setErr(null)
    try { await onSubmit(pw) } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9100,
        background: "rgba(0,0,0,0.85)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 440,
          background: "var(--bg)",
          border: "1px solid var(--divider-strong)",
          padding: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
          <span style={{ color: "var(--fg)", letterSpacing: "0.12em" }}>ADMIN LOGIN</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{ color: "var(--fg-mute)", cursor: "pointer", fontSize: "var(--fs-sm)" }}
          >x</button>
        </div>

        <label style={{ display: "block" }}>
          <span style={{ color: "var(--fg-dim)", fontSize: "var(--fs-xs)", letterSpacing: "0.14em" }}>PASSWORD</span>
          <input
            ref={ref}
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
            style={{
              display: "block", width: "100%", marginTop: 6,
              padding: "6px 0 8px 0",
              fontSize: 16,
              color: "var(--fg)",
              borderBottom: "1px solid var(--divider-strong)",
            }}
          />
        </label>

        {err ? (
          <p style={{ color: "var(--c-error)", fontSize: "var(--fs-sm)", margin: "12px 0 0 0" }}>! {err}</p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{
              color: "var(--fg)",
              background: "var(--bg-soft)",
              border: "1px solid var(--divider-strong)",
              padding: "8px 18px",
              fontSize: "var(--fs-sm)",
              letterSpacing: "0.12em",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >AUTHENTICATE →</button>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// FILE: components/CommandPalette.tsx
// =============================================================================

/**
 * CommandPalette — Ctrl+K / ?
 *
 * Centered modal. Type to fuzzy-filter; ↑↓ to move; Enter to invoke;
 * Esc to dismiss. Commands are grouped (navigate / run / log / shell).
 *
 * One palette = one entry point to every action. Keeps the HelpBar
 * tiny and avoids the "13 chips at the bottom" anti-pattern.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type { Command, CommandGroup } from "../commands"
import { fuzzyScore } from "../commands"

interface Props {
  commands: Command[]
  onClose: () => void
}

const GROUP_LABEL: Record<CommandGroup, string> = {
  navigate: "navigate",
  run:      "run",
  log:      "log",
  shell:    "shell",
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const matches = useMemo(() => {
    const scored = commands
      .map((cmd) => ({ cmd, score: fuzzyScore(query, cmd.label) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label))
    return scored.map((m) => m.cmd)
  }, [commands, query])

  useEffect(() => { setCursor(0) }, [query])

  // Group while preserving cursor order across the flat list.
  const grouped = useMemo(() => {
    const out: { group: CommandGroup; items: Command[] }[] = []
    const order: CommandGroup[] = ["run", "navigate", "log", "shell"]
    for (const g of order) {
      const items = matches.filter((c) => c.group === g)
      if (items.length) out.push({ group: g, items })
    }
    return out
  }, [matches])

  // Flat index → command, used for arrow nav
  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  function invoke(cmd: Command) {
    onClose()
    // Defer so the palette unmounts before the command (which may open
    // another modal) runs.
    queueMicrotask(() => { void cmd.run() })
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "rgba(12,12,16,0.78)",
        display: "flex", justifyContent: "center", alignItems: "flex-start",
        paddingTop: "12vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)", maxHeight: "70vh",
          background: "var(--bg-elev)",
          border: "1px solid var(--divider-strong)",
          borderRadius: 4,
          display: "flex", flexDirection: "column",
          fontFamily: "var(--font-mono)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
      >
        {/* Title */}
        <div
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid var(--divider)",
            display: "flex", alignItems: "center", gap: 12,
            color: "var(--fg-dim)", fontSize: "var(--fs-xs)",
            letterSpacing: "0.14em", textTransform: "uppercase",
          }}
        >
          <span style={{ color: "var(--accent)" }}>command</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-mute)", textTransform: "none", letterSpacing: "0.04em" }}>
            {flat.length}/{commands.length} · Up/Down · Enter · Esc
          </span>
        </div>

        {/* Filter input */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--divider)",
            display: "flex", alignItems: "center", gap: 10,
            background: "var(--bg-input)",
          }}
        >
          <span style={{ color: "var(--accent)", fontSize: "var(--fs-base)" }}>&gt;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); return }
              if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) {
                e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0))); return
              }
              if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) {
                e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return
              }
              if (e.key === "Enter") {
                e.preventDefault()
                const cmd = flat[cursor]
                if (cmd) invoke(cmd)
              }
            }}
            placeholder="search commands…"
            spellCheck={false}
            style={{
              flex: 1,
              color: "var(--fg)", fontSize: "var(--fs-base)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>

        {/* List */}
        <div style={{ overflow: "auto", flex: 1, padding: "4px 0" }}>
          {flat.length === 0 ? (
            <div style={{ color: "var(--fg-mute)", padding: "16px 14px", fontSize: "var(--fs-sm)" }}>
              no commands match.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.group} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    padding: "6px 14px 2px",
                    color: "var(--fg-mute)",
                    fontSize: "var(--fs-xs)",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                  }}
                >
                  {GROUP_LABEL[g.group]}
                </div>
                {g.items.map((cmd) => {
                  const idx = flat.indexOf(cmd)
                  const selected = idx === cursor
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => invoke(cmd)}
                      style={{
                        width: "100%", textAlign: "left",
                        display: "grid",
                        gridTemplateColumns: "1fr auto",
                        gap: 12, alignItems: "center",
                        padding: "5px 14px",
                        background: selected ? "var(--bg-soft)" : "transparent",
                        borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
                        color: "var(--fg)",
                        fontSize: "var(--fs-sm)",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
                        <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {cmd.label}
                        </span>
                        {cmd.hint ? (
                          <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>{cmd.hint}</span>
                        ) : null}
                      </span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--fg-mute)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
                        {cmd.slash ? <kbd style={kbdStyle}>/{cmd.slash}</kbd> : null}
                        {cmd.keybind ? <kbd style={kbdStyle}>{cmd.keybind}</kbd> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-xs)",
  background: "var(--bg)",
  border: "1px solid var(--divider)",
  padding: "1px 6px",
  borderRadius: 3,
  color: "var(--fg-dim)",
  letterSpacing: "0.02em",
}

// =============================================================================
// FILE: components/GoalInput.tsx
// =============================================================================

/**
 * GoalInput — bottom prompt bar.
 *
 *   > _ enter your goal here…
 *
 * Multi-line capable (Shift+Enter newline; Enter submits). When the user
 * types `/` as the first character, a slash-command popup appears with
 * intellisense-style autocomplete:
 *
 *   ↑↓        navigate suggestions
 *   Tab       accept the highlighted slash into the input (lets you edit args later)
 *   Enter     run the highlighted slash directly (or submit normally if popup empty)
 *   Esc       close the popup without acting
 *
 * Suggestions are computed by the parent via `getSuggestions`, which closes
 * over the canonical command registry. This keeps the input dumb and lets
 * the registry stay the single source of truth for slash semantics.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import type { SlashSuggestion } from "../commands"

export interface GoalInputHandle {
  focus(): void
}

interface Props {
  busy: boolean
  pendingQuestion: string | null
  onSubmit: (text: string) => void
  /** Called with the current draft; returns slash suggestions (may be empty). */
  getSuggestions?: (text: string) => SlashSuggestion[]
}

export const GoalInput = forwardRef<GoalInputHandle, Props>(function GoalInput(
  { busy, pendingQuestion, onSubmit, getSuggestions },
  ref,
) {
  const [val, setVal] = useState("")
  const [cursor, setCursor] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }))

  // ── Suggestions ──
  // Only computed when the draft starts with "/" on its first line. Recomputed
  // on every keystroke; cheap (registry has ~10 entries).
  const suggestions = useMemo<SlashSuggestion[]>(() => {
    if (!getSuggestions) return []
    return getSuggestions(val)
  }, [val, getSuggestions])

  const popupOpen = suggestions.length > 0
  const safeCursor = popupOpen ? Math.min(cursor, suggestions.length - 1) : 0

  useEffect(() => { setCursor(0) }, [val.split("\n")[0]])

  function submit() {
    const text = val.trim()
    if (!text) return
    onSubmit(text)
    setVal("")
    setCursor(0)
  }

  function acceptIntoInput(s: SlashSuggestion) {
    // Replace the first line with the canonical slash and a trailing space.
    // Preserves anything on subsequent lines (rare for slash commands but cheap).
    const rest = val.includes("\n") ? "\n" + val.split("\n").slice(1).join("\n") : ""
    const next = `/${s.slash} ${rest}`.trimEnd()
    setVal(next.endsWith(" ") || rest ? next : next + " ")
    setCursor(0)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      const pos = `/${s.slash} `.length
      ta.setSelectionRange(pos, pos)
    })
  }

  function runSuggestion(s: SlashSuggestion) {
    setVal("")
    setCursor(0)
    void s.run()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen) {
      if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) {
        e.preventDefault()
        setCursor((c) => (c + 1) % suggestions.length)
        return
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) {
        e.preventDefault()
        setCursor((c) => (c - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === "Tab") {
        e.preventDefault()
        const pick = suggestions[safeCursor]
        if (pick) acceptIntoInput(pick)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        // Clear just the slash so the popup closes; keep the rest.
        setVal((v) => v.replace(/^\/[^\s]*\s?/, ""))
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        const pick = suggestions[safeCursor]
        if (pick) runSuggestion(pick)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const responding = !!pendingQuestion
  const promptGlyph = responding ? "?" : ">"
  const promptColor = responding ? "var(--c-audit)" : "var(--accent)"
  const placeholder = responding
    ? `responding to: ${pendingQuestion!.slice(0, 64)}${pendingQuestion!.length > 64 ? "\u2026" : ""}`
    : busy
      ? "run is streaming \u2014 type /cancel to abort, /rerun to restart, or /rollback to revert effects"
      : "enter a goal, or type / for commands  \u2014  Enter to submit, Shift+Enter for newline"

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      {popupOpen ? (
        <SuggestionPopup
          items={suggestions}
          cursor={safeCursor}
          onHover={setCursor}
          onPick={runSuggestion}
        />
      ) : null}

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          background: "var(--bg-input)",
          padding: "8px 12px",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <span style={{ color: promptColor, fontWeight: 500, lineHeight: "1.6", userSelect: "none" }}>
          {promptGlyph}
        </span>
        <textarea
          ref={taRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            resize: "none",
            minHeight: "1.6em",
            maxHeight: "10em",
            color: "var(--fg)",
            fontSize: "var(--fs-base)",
            fontFamily: "var(--font-mono)",
            lineHeight: "1.6",
          }}
        />
        <span
          style={{
            color: busy && !responding ? "var(--c-run)" : "var(--fg-mute)",
            fontSize: "var(--fs-xs)",
            letterSpacing: "0.06em",
            marginTop: 4,
            userSelect: "none",
            whiteSpace: "nowrap",
          }}
        >
          {responding ? "Enter respond" : busy ? "[busy]" : "Enter run"}
        </span>
      </div>
    </div>
  )
})

// ── Suggestion popup ─────────────────────────────────────────────────────────
//
// Floats above the input. Limited to 8 visible rows; if more match, the rest
// scroll. Click → run, hover → highlight (synced with keyboard cursor).

function SuggestionPopup({
  items,
  cursor,
  onHover,
  onPick,
}: {
  items: SlashSuggestion[]
  cursor: number
  onHover: (i: number) => void
  onPick: (s: SlashSuggestion) => void
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: "calc(100% + 4px)",
        maxHeight: "32vh",
        overflowY: "auto",
        background: "var(--bg-elev)",
        border: "1px solid var(--divider-strong)",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-sm)",
        zIndex: 50,
      }}
      onMouseDown={(e) => e.preventDefault() /* keep textarea focused */}
    >
      <div
        style={{
          padding: "4px 10px",
          color: "var(--fg-mute)",
          fontSize: "var(--fs-xs)",
          letterSpacing: "0.04em",
          borderBottom: "1px solid var(--divider)",
          display: "flex",
          gap: 12,
        }}
      >
        <span>commands · {items.length}</span>
        <span style={{ flex: 1 }} />
        <span>
          <Kbd>↑↓</Kbd> nav · <Kbd>Tab</Kbd> insert · <Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close
        </span>
      </div>
      {items.map((s, i) => {
        const active = i === cursor
        return (
          <div
            key={s.slash}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(s)}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              padding: "5px 10px",
              cursor: "pointer",
              background: active ? "var(--bg-soft)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-dim)",
              borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
            }}
          >
            <span style={{ color: "var(--accent)", minWidth: 90 }}>
              /{s.slash}
              {s.alias && s.alias !== s.slash ? (
                <span style={{ color: "var(--fg-mute)" }}> ({s.alias})</span>
              ) : null}
            </span>
            <span style={{ flex: 1 }}>{s.label}</span>
            {s.hint ? (
              <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>{s.hint}</span>
            ) : null}
            {s.keybind ? <Kbd>{s.keybind}</Kbd> : null}
          </div>
        )
      })}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: "var(--accent)",
      background: "var(--bg-soft)",
      padding: "1px 6px",
      borderRadius: 3,
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-xs)",
    }}>{children}</span>
  )
}

// =============================================================================
// FILE: components/LogPane.tsx
// =============================================================================

/**
 * LogPane — right half. The unified operations log.
 *
 * Every SSE envelope flows in. The user can:
 *   - Free-text search (substring over message + JSON)
 *   - Prefix filters:  type:llm-request   kind:agent   run:<id>   err:1
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
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
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
  | "sync" | "system" | "debug" | "error" | "ok"

const CAT_COLOR: Record<Category, string> = {
  run:    "var(--c-run)",
  step:   "var(--c-step)",
  agent:  "var(--c-llm)",       // agent-originated lives in the lavender lane
  tool:   "var(--c-tool)",
  audit:  "var(--c-audit)",
  sync:   "var(--c-sync)",
  system: "var(--fg-dim)",
  debug:  "var(--c-debug)",
  error:  "var(--c-error)",
  ok:     "var(--c-ok)",
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
  if (t === "run.completed" || /\.ok$|\.success$/i.test(t)) return "ok"
  if (t.startsWith("run."))   return "run"
  if (t.startsWith("step."))  return "step"
  // Agent-originated: prompts, llm calls, thinking, iteration markers, nudges.
  if (t.startsWith("agent.")) return "agent"
  if (t.startsWith("llm."))   return "agent"
  if (t.startsWith("tool.") || t.includes("tool_"))  return "tool"
  if (t.startsWith("audit.") || t.includes("user"))  return "audit"
  if (t.startsWith("sync."))  return "sync"
  if (t.startsWith("debug.")) return "debug"
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
// Syntax (whitespace-separated tokens):
//   type:llm-request,llm-response   include rows whose type contains ANY of these
//   kind:agent,tool                 include rows whose category is ANY of these
//   run:abc123,def456               include rows whose runId starts with ANY
//   err:1                           only error rows
//   -kind:debug                     EXCLUDE debug rows (negation prefix "-")
//   -type:api.request               exclude api.request rows
//   freetext words                  substring match anywhere
//
// All keys are AND'd; values inside one key are OR'd. Negations override.

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
    const m = /^(type|kind|run|err):(.*)$/.exec(body)
    if (!m) { free.push(tok); continue }
    const [, key, value] = m
    const target = negated ? out.exclude : out.include
    if (key === "type") {
      target.types = [...(target.types ?? []), ...splitCsv(value.toLowerCase())]
    } else if (key === "kind") {
      target.kinds = [...(target.kinds ?? []), ...(splitCsv(value.toLowerCase()) as Category[])]
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
    const t = effectiveType(e).toLowerCase()
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
  if (Number.isNaN(d.getTime())) return iso.slice(11, 23)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
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
    // Walk newest→oldest so the cap drops the oldest 800+ rows, then reverse
    // back so the rendered order is chronological (oldest top, newest bottom).
    const out: WsEvent[] = []
    for (let i = events.length - 1; i >= 0 && out.length < 800; i--) {
      const ev = events[i]!
      if (matches(ev, parsed)) out.push(ev)
    }
    return out.reverse()
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

  return (
    <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <PaneHeader active={active} title="OPERATIONS" hint={`${visible.length}/${events.length}`} hotkey="Ctrl+2" />

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
          placeholder="filter — type:llm-request,llm-response  kind:agent,tool  -kind:debug  run:a3f9c…"
          spellCheck={false}
          style={{ flex: 1, color: "var(--fg)", fontSize: "var(--fs-base)" }}
        />
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

      {/* Rows */}
      <div ref={scrollRef} onScroll={onScroll} tabIndex={-1} style={{ flex: 1, overflow: "auto", position: "relative", outline: "none" }}>
        {visible.length === 0 ? (
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-sm)", padding: "8px 14px" }}>
            no events match.
          </div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
            {visible.map((e, i) => {
              const cat = categoryFor(e)
              const typeLabel = effectiveType(e)
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
                      borderLeft: `2px solid ${CAT_COLOR[cat]}`,
                      color: "var(--fg)",
                      fontSize: "var(--fs-sm)",
                    }}
                    onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = "var(--bg-soft)" }}
                    onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = "transparent" }}
                  >
                    <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
                      {fmtClock(e.timestamp)}
                    </span>
                    <span style={{ color: CAT_COLOR[cat], fontSize: "var(--fs-xs)", letterSpacing: "0.04em" }}>
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
                        borderLeft: `2px solid ${CAT_COLOR[cat]}`,
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
  )
})

// =============================================================================
// FILE: components/RunPicker.tsx
// =============================================================================

/**
 * RunPicker — terminal-style modal for selecting a run.
 *
 *   ┌─ runs ─────────────────────────────────────────────── esc ─┐
 *   │ > _filter_                                                 │
 *   ├────────────────────────────────────────────────────────────┤
 *   │ 2026-04-30 18:04:22  a3f9c12d  ● completed                 │
 *   │   summarise the lineage of customer orders and …           │
 *   │ ─────                                                      │
 *   │ 2026-04-30 17:51:08  9e1b774a  ◐ running                   │
 *   │   build a delta sync recipe for dbo.Customers              │
 *   └────────────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useRef, useState } from "react"
import type { Run } from "../types"

interface Props {
  runs: Run[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

const STATUS_LABEL: Record<string, string> = {
  pending: "[pending]", running: "[running]", streaming: "[streaming]",
  completed: "[ok]", failed: "[fail]", cancelled: "[cancelled]",
}
const STATUS_COLOR: Record<string, string> = {
  pending: "var(--fg-dim)", running: "var(--c-run)", streaming: "var(--c-run)",
  completed: "var(--c-ok)", failed: "var(--c-error)", cancelled: "var(--fg-mute)",
}

function fmtFullTime(iso: string): string {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch { return iso }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

export function RunPicker({ runs, activeId, onSelect, onClose }: Props) {
  const [filter, setFilter] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      (r.goal ?? "").toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
    )
  }, [runs, filter])

  useEffect(() => { setCursor(0) }, [filter])
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-row='${cursor}']`)
    node?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); return
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const r = filtered[cursor]
      if (r) { onSelect(r.id); onClose() }
    }
  }

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 92vw)",
          maxHeight: "75vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-elev)",
          border: "1px solid var(--divider-strong)",
          borderRadius: 6,
          boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {/* title bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "8px 14px",
            borderBottom: "1px solid var(--divider)",
            color: "var(--fg-dim)",
            fontSize: "var(--fs-sm)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "var(--accent)" }}>runs</span>
          <span style={{ marginLeft: 10, color: "var(--fg-mute)" }}>{filtered.length}/{runs.length}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-mute)" }}>Up/Down select &middot; Enter open &middot; Esc close</span>
        </div>

        {/* filter */}
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--divider)" }}>
          <span style={{ color: "var(--accent)", marginRight: 10, fontSize: "var(--fs-base)" }}>{">"}</span>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKey}
            placeholder="filter by id, goal, status…"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--fg)",
              fontFamily: "inherit",
              fontSize: "var(--fs-base)",
            }}
          />
        </div>

        {/* list */}
        <div ref={listRef} style={{ overflowY: "auto", padding: "6px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "20px 14px", color: "var(--fg-mute)" }}>no runs match</div>
          ) : filtered.map((r, idx) => {
            const isActive = r.id === activeId
            const isCursor = idx === cursor
            return (
              <div
                key={r.id}
                data-row={idx}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => { onSelect(r.id); onClose() }}
                style={{
                  padding: "10px 14px",
                  cursor: "pointer",
                  background: isCursor ? "var(--bg-soft)" : "transparent",
                  borderLeft: `3px solid ${isActive ? "var(--accent)" : "transparent"}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: "var(--fs-sm)" }}>
                  <span style={{ color: "var(--fg-mute)", width: 168 }}>{fmtFullTime(r.createdAt)}</span>
                  <span style={{ color: "var(--accent)", width: 96 }}>{r.id.slice(0, 8)}</span>
                  <span style={{ color: STATUS_COLOR[r.status] ?? "var(--fg-dim)", width: 110 }}>
                    {STATUS_LABEL[r.status] ?? `[${r.status}]`}
                  </span>
                  <span style={{ flex: 1, color: "var(--fg-mute)", fontSize: "var(--fs-xs)", textAlign: "right" }}>
                    {r.stepCount} steps · {r.totalTokens} tok
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    paddingLeft: 0,
                    color: isCursor ? "var(--fg)" : "var(--fg-dim)",
                    fontSize: "var(--fs-base)",
                    lineHeight: 1.45,
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                  }}
                >
                  {truncate(r.goal ?? "(no goal)", 120)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// FILE: components/StatusBar.tsx
// =============================================================================

/**
 * StatusBar — single line at the very top.
 *
 *   agent001 // term · joe.smith@… · run a3f9c ◐ running · 18:04:22  ● live  ⇆ classic
 *
 * The UI switcher sits inline at the right edge so it can't overlap
 * any pane content underneath.
 */

import { useEffect, useState } from "react"
import type { Me, Run } from "../types"
import { setUiShell, urlForShell } from "../uiPref"

interface Props {
  me: Me | null
  run: Run | null
  runs: Run[]
  connected: boolean
  onSwitchUser: () => void
  onOpenPicker: () => void
  onAbortRun?: () => void
}

const STATUS_LABEL: Record<string, string> = {
  pending:    "[pending]",
  running:    "[running]",
  streaming:  "[streaming]",
  completed:  "[ok]",
  failed:     "[fail]",
  cancelled:  "[cancelled]",
}

const STATUS_COLOR: Record<string, string> = {
  pending:    "var(--fg-dim)",
  running:    "var(--c-run)",
  streaming:  "var(--c-run)",
  completed:  "var(--c-ok)",
  failed:     "var(--c-error)",
  cancelled:  "var(--fg-mute)",
}

function fmtTime(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

export function StatusBar({ me, run, runs, connected, onSwitchUser, onOpenPicker, onAbortRun }: Props) {
  const [now, setNow] = useState(fmtTime())
  useEffect(() => {
    const t = window.setInterval(() => setNow(fmtTime()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const sep = <span style={{ color: "var(--fg-mute)", margin: "0 12px" }}>·</span>

  return (
    <header
      style={{
        height: 32,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        borderBottom: "1px solid var(--divider)",
        fontSize: "var(--fs-sm)",
        color: "var(--fg-dim)",
        userSelect: "none",
        flexShrink: 0,
        background: "var(--bg)",
      }}
    >
      <span style={{ color: "var(--fg)", letterSpacing: "0.1em" }}>agent001</span>
      <span style={{ color: "var(--fg-mute)", marginLeft: 8, marginRight: 8 }}>//</span>
      <span style={{ color: "var(--accent)", letterSpacing: "0.08em" }}>term</span>

      {sep}

      <button
        type="button"
        onClick={onSwitchUser}
        style={{ color: me ? "var(--fg)" : "var(--fg-mute)", cursor: "pointer" }}
        title="Switch identity"
      >
        {me?.upn ?? me?.displayName ?? "anonymous"}
        {me?.isAdmin ? <span style={{ color: "var(--accent)", marginLeft: 8 }}>admin</span> : null}
      </button>

      {sep}

      {run ? (
        <button
          type="button"
          onClick={onOpenPicker}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
          title={`Show recent runs (${runs.length})`}
        >
          <span style={{ color: "var(--fg-dim)" }}>run</span>
          <span style={{ color: "var(--fg)" }}>{run.id.slice(0, 7)}</span>
          <span style={{ color: STATUS_COLOR[run.status] ?? "var(--fg-dim)" }}>
            {STATUS_LABEL[run.status] ?? `[${run.status}]`}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpenPicker}
          style={{ color: "var(--fg-mute)", cursor: "pointer" }}
          title="Open run picker"
        >
          no active run {runs.length > 0 ? `(${runs.length} past)` : ""}
        </button>
      )}

      {/* Abort button — only shown while a run is active. Click sends /cancel. */}
      {run && (run.status === "running" || run.status === "pending") && onAbortRun ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAbortRun() }}
          title="Abort the active run (Ctrl+. or /cancel)"
          style={{
            marginLeft: 10,
            color: "var(--c-error)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-sm)",
            padding: "2px 8px",
            background: "transparent",
            border: "1px solid var(--c-error)",
            borderRadius: 3,
            cursor: "pointer",
            letterSpacing: "0.04em",
          }}
        >
          [abort]
        </button>
      ) : null}

      <span style={{ flex: 1 }} />

      <span style={{ color: "var(--fg-mute)" }}>{now}</span>
      <span
        style={{
          marginLeft: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: connected ? "var(--c-ok)" : "var(--c-error)",
        }}
        title={connected ? "stream connected" : "stream disconnected"}
      >
        <span
          className={connected ? "t-spin" : ""}
          style={{
            width: 10,
            display: "inline-block",
            textAlign: "center",
            fontFamily: "var(--font-mono)",
          }}
        >
          {connected ? "" : "X"}
        </span>
      </span>

      <button
        type="button"
        onClick={() => { setUiShell("classic"); window.location.assign(urlForShell("classic")) }}
        title="Switch to classic UI"
        style={{
          marginLeft: 14,
          color: "var(--fg-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-sm)",
          padding: "2px 4px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--accent)" }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--fg-dim)" }}
      >
        [&lt;|&gt;]
      </button>
    </header>
  )
}

// =============================================================================
// FILE: components/StreamPane.tsx
// =============================================================================

/**
 * StreamPane — left half. Renders the active run's transcript as a
 * tight, line-oriented "agent terminal":
 *
 *   > goal text
 *     planning…
 *   ✓ tool list_runs            12ms
 *     ↳ 14 results
 *   ⏵ thinking…
 *   ⏵ … streamed answer chunks here …
 *   ✓ done
 *
 * No bubbles, no avatars — pure typed output. The active streaming
 * answer renders with a blinking caret at the end.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import type { TranscriptKind, TranscriptRow } from "../store"

export interface StreamPaneHandle {
  focus(): void
  jumpToBottom(): void
}

interface Props {
  active: boolean
  rows: TranscriptRow[]
  streaming: string
  goalPlaceholder: string | null
  activeRunId: string | null
}

const KIND_GLYPH: Record<TranscriptKind, string> = {
  goal:        ">",
  thinking:    "..",
  tool:        "->",
  "tool-result":"ok",
  "tool-error": "!!",
  answer:      "<-",
  error:       "!!",
  "user-input":"?",
  info:        "*",
}

const KIND_COLOR: Record<TranscriptKind, string> = {
  goal:        "var(--accent)",
  thinking:    "var(--c-llm)",
  tool:        "var(--c-tool)",
  "tool-result":"var(--c-tool)",
  "tool-error": "var(--c-error)",
  answer:      "var(--fg)",
  error:       "var(--c-error)",
  "user-input":"var(--c-audit)",
  info:        "var(--fg-dim)",
}

const KIND_TEXT_COLOR: Record<TranscriptKind, string> = {
  goal:        "var(--fg)",
  thinking:    "var(--fg-dim)",
  tool:        "var(--fg)",
  "tool-result":"var(--fg-dim)",
  "tool-error": "var(--c-error)",
  answer:      "var(--fg)",
  error:       "var(--c-error)",
  "user-input":"var(--fg)",
  info:        "var(--fg-dim)",
}

export const StreamPane = forwardRef<StreamPaneHandle, Props>(function StreamPane(
  { active, rows, streaming, goalPlaceholder, activeRunId }, ref
) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
    jumpToBottom: () => {
      const el = scrollRef.current
      if (el) { el.scrollTop = el.scrollHeight; el.focus() }
    },
  }))

  // Force-scroll to bottom whenever the active run changes (switching runs
  // or starting a new one). This re-engages sticky-scroll even if the user
  // had scrolled up in the previous run.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeRunId])

  // Sticky-scroll during an active run: follow new output unless the user
  // has scrolled up more than 80px from the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 80) el.scrollTop = el.scrollHeight
  }, [rows.length, streaming])

  const empty = rows.length === 0 && !streaming

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--divider)",
      }}
    >
      <PaneHeader active={active} title="STREAM" hint="run output" hotkey="Ctrl+1" />
      <div
        ref={scrollRef}
        tabIndex={-1}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 14px 14px 14px",
          outline: "none",
        }}
      >
        {empty ? (
          <div style={{ color: "var(--fg-mute)", fontSize: "var(--fs-sm)", padding: "8px 0" }}>
            {goalPlaceholder
              ? `idle — type a goal at the prompt below to start a run.`
              : `idle.`}
          </div>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows.map((r) => <Row key={r.id} row={r} />)}
            {streaming ? (
              <li style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "1px 0" }}>
                <span style={{ color: "var(--c-llm)", width: 22, flexShrink: 0, whiteSpace: "pre", lineHeight: "1.5" }}>{"<-"}</span>
                <pre
                  style={{
                    margin: 0,
                    fontFamily: "inherit",
                    fontSize: "inherit",
                    color: "var(--fg)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >{streaming}<span className="t-caret" /></pre>
              </li>
            ) : null}
          </ol>
        )}
      </div>
    </section>
  )
})

function Row({ row }: { row: TranscriptRow }) {
  return (
    <li style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "1px 0" }}>
      <span style={{ color: KIND_COLOR[row.kind], width: 22, flexShrink: 0, whiteSpace: "pre", lineHeight: "1.5" }}>
        {KIND_GLYPH[row.kind]}
      </span>
      <pre
        style={{
          margin: 0,
          flex: 1,
          fontFamily: "inherit",
          fontSize: "inherit",
          color: KIND_TEXT_COLOR[row.kind],
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: "1.5",
        }}
      >{row.text || (row.kind === "thinking" ? "…" : "")}</pre>
      {row.meta ? (
        <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)", flexShrink: 0, marginLeft: 8 }}>
          {row.meta}
        </span>
      ) : null}
    </li>
  )
}

export function PaneHeader({
  active, title, hint, hotkey,
}: { active: boolean; title: string; hint?: string; hotkey?: string }) {
  return (
    <div
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        fontSize: "var(--fs-sm)",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: active ? "var(--accent)" : "var(--fg-dim)",
        borderBottom: "1px solid var(--divider)",
        userSelect: "none",
        flexShrink: 0,
        background: active ? "var(--bg-soft)" : "transparent",
      }}
    >
      {hotkey ? (
        <span style={{ color: "var(--fg-mute)", marginRight: 8, fontSize: "var(--fs-xs)" }}>[{hotkey}]</span>
      ) : null}
      <span>{title}</span>
      {hint ? (
        <span style={{ color: "var(--fg-mute)", marginLeft: 12, textTransform: "none", letterSpacing: "0.04em", fontSize: "var(--fs-xs)" }}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

// =============================================================================
// FILE: components/VisualPane.tsx
// =============================================================================

/**
 * VisualPane — live visual representation of the agent pipeline.
 *
 * Data source: `transcript` (same TranscriptRow[] that StreamPane uses,
 * already filtered to the active run) + `streamingAnswer` + `runs`.
 * This is intentionally the same data — just displayed as motion graphics
 * instead of text rows.
 *
 * Visual language
 * ───────────────
 * Four vertical wave-gate curves (identical to index4.html) represent
 * the four processing layers:  IN  ·  EXEC  ·  LLM  ·  OUT
 *
 * Ambient particles flow left → right through all four gates as a calm
 * baseline rhythm.  They do NOT represent individual operations.
 *
 * Real operations appear ON TOP as named, coloured particles:
 *
 *   goal         → text anchors top-centre; wave gates brighten slightly
 *   tool         → a labelled node spawns left of the EXEC gate and
 *                  travels toward it; pins there (pulsing) while active
 *   tool-result  → node flashes and crosses the gate; continues to OUT
 *   tool-error   → node turns red and explodes
 *   thinking     → text surfaces centre-screen, fades over ~8 s
 *   answer       → final answer accumulates in a bottom strip
 *   streaming    → live token stream builds in the same strip
 *
 * Metrics: iter / tokens / in-flight tools — bottom-right, ~20 % opacity.
 *
 * ask_user: clean modal over the canvas.  Canvas keeps breathing.
 */

import type { CSSProperties } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { TranscriptRow } from "../store"
import { useStore } from "../store"

// ─────────────────────────────────────────────────────────────────────────────
// Tool category → colour
// ─────────────────────────────────────────────────────────────────────────────

type RGB = readonly [number, number, number]

const CAT_RGB: Record<string, RGB> = {
  db:       [68,  140, 255],
  file:     [68,  210, 140],
  delegate: [175, 100, 255],
  web:      [255, 140,  68],
  search:   [255, 210,  68],
  shell:    [255,  68, 140],
  llm:      [160, 255, 220],
  answer:   [200, 200, 200],
  error:    [255,  80,  80],
  other:    [150, 150, 162],
}

function categorize(name: string): string {
  const n = name.toLowerCase()
  if (/sql|db|query|mssql|database|table|schema|postgres|mongo/.test(n)) return "db"
  if (/file|read|write|path|fs|dir|folder|edit|list_file/.test(n))       return "file"
  if (/delegate|spawn|agent|sub|worker/.test(n))                          return "delegate"
  if (/browser|web|http|fetch|scrape|url|navigate/.test(n))              return "web"
  if (/search|find|grep|rg|ripgrep/.test(n))                             return "search"
  if (/shell|exec|run|bash|cmd|script/.test(n))                          return "shell"
  return "other"
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave gate geometry  (mirrors index4.html shader)
// ─────────────────────────────────────────────────────────────────────────────

const G_CENTER  = [-0.82, -0.28,  0.22,  0.72] as const
const G_PH_MUL  = [0.052,  0.039, 0.061, 0.044] as const
const G_PH_OFS  = [0.000,  1.830, 3.720, 5.110] as const
const G_SIN = [
  [0.20, 2.0, 0.08, 4.7, 2.1],
  [0.12, 5.3, 0.06, 2.9, 0.7],
  [0.18, 3.4, 0.07, 6.1, 1.3],
  [0.14, 4.1, 0.09, 2.3, 1.6],
] as const
const G_LABEL = ["in", "exec", "llm", "out"] as const
const WAVE_AMP = 0.45

function gateXAt(s: number, yn: number, halfW: number, t: number): number {
  const ph = t * G_PH_MUL[s]! + G_PH_OFS[s]!
  const [a1, f1, a2, f2, pm] = G_SIN[s]!
  return halfW + (G_CENTER[s]! + a1 * Math.sin(f1 * yn + ph) + a2 * Math.sin(f2 * yn + ph * pm)) * halfW * WAVE_AMP
}

// ─────────────────────────────────────────────────────────────────────────────
// Ambient particle  (background rhythm only — not data-driven)
// ─────────────────────────────────────────────────────────────────────────────

interface Pt {
  x: number; y: number; spd: number; stage: number
  pinned: boolean; pinnedAt: number; delay: number; rnd: number
}

function spawnPt(cw: number, ch: number): Pt {
  const rnd = Math.random()
  // Particles flow through all four gates: IN (0), EXEC (1), LLM (2), OUT (3).
  const s = Math.floor(Math.random() * 4)
  const approxGateX = (0.5 + G_CENTER[s]! * WAVE_AMP * 0.5) * cw
  return {
    x:        Math.max(2, approxGateX - (0.04 + rnd * 0.18) * cw),
    y:        Math.random() * ch,
    spd:      14 + rnd * 18,
    stage:    s, pinned: false, pinnedAt: 0,
    delay:    600 + rnd * 2600, rnd,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real operation node  (one per tool call, data-driven)
// ─────────────────────────────────────────────────────────────────────────────

interface OpNode {
  rowId: string
  toolCallId?: string   // for correlating result/error to the right node when parallel
  label: string
  cat: string
  rgb: RGB
  born: number
  y: number
  phase: "approach" | "active" | "complete" | "error"
  doneAt: number
  x: number
  targetX: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Ripple
// ─────────────────────────────────────────────────────────────────────────────

interface Ripple {
  gateIdx: number; yFrac: number; born: number; rgb: RGB; maxR: number
}

// ─────────────────────────────────────────────────────────────────────────────
// All mutable visual state  (ref — never triggers React renders)
// ─────────────────────────────────────────────────────────────────────────────

interface VS {
  t: number; lastMs: number
  pts: Pt[]
  ops: OpNode[]
  ripples: Ripple[]
  thinking: string; thinkAlpha: number; thinkAt: number
  goal: string
  answer: string
  streaming: boolean
  iter: number; tokens: number; toolsActive: number
  status: "" | "running" | "completed" | "failed"
  ingestedIdx: number
  gateHeat: Float32Array
  currentRunId: string
}

function initVS(cw: number, ch: number): VS {
  return {
    t: 0, lastMs: performance.now(),
    pts: Array.from({ length: 160 }, () => spawnPt(cw, ch)),
    ops: [], ripples: [],
    thinking: "", thinkAlpha: 0, thinkAt: 0,
    goal: "", answer: "", streaming: false,
    iter: 0, tokens: 0, toolsActive: 0,
    status: "", ingestedIdx: 0,
    gateHeat: new Float32Array(4),
    currentRunId: "",
  }
}

function heatGate(vs: VS, idx: number, sec: number) {
  vs.gateHeat[idx] = Math.max(vs.gateHeat[idx]!, sec)
}

function spawnRipple(vs: VS, gateIdx: number, yFrac: number, rgb: RGB, maxR = 45) {
  vs.ripples.push({ gateIdx, yFrac, born: performance.now(), rgb, maxR })
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest a single TranscriptRow into visual state
// ─────────────────────────────────────────────────────────────────────────────

function ingestRow(vs: VS, row: TranscriptRow, cw: number, ch: number) {
  const now = performance.now()
  const halfW = cw * 0.5

  switch (row.kind) {
    case "goal": {
      vs.goal = row.text; vs.status = "running"
      vs.answer = ""; vs.streaming = false
      vs.iter = 0; vs.tokens = 0
      vs.ops = []; vs.thinking = ""; vs.thinkAlpha = 0
      heatGate(vs, 0, 1.2)  // IN gate lights on new goal
      heatGate(vs, 2, 0.8)
      spawnRipple(vs, 0, 0.5, [200, 200, 220], 15)
      break
    }
    case "thinking": {
      vs.thinking   = row.text.length > 180 ? row.text.slice(0, 179) + "…" : row.text
      vs.thinkAlpha = 1; vs.thinkAt = now
      heatGate(vs, 2, 1.8)
      spawnRipple(vs, 2, 0.38 + Math.random() * 0.24, [160, 255, 220], 11)
      break
    }
    case "tool": {
      const label = row.text.split(/\s{2,}/)[0]?.trim() ?? row.text
      const rgb: RGB = [255, 210, 68]  // single yellow for all tool nodes
      const yn    = Math.random() * 1.6 - 0.8
      const gx    = gateXAt(1, yn, halfW, vs.t)
      const y     = ch * 0.5 + yn * ch * 0.5
      vs.ops.push({
        rowId: row.id, toolCallId: row.toolCallId, label, cat: "tool", rgb,
        born: now, y,
        phase: "approach",
        doneAt: 0,
        x:        Math.max(0, gx - cw * 0.28),
        targetX:  gx,
      })
      heatGate(vs, 1, 2.2)
      break
    }
    case "tool-result": {
      // Match by toolCallId (parallel-safe) then fall back to last active node
      const op = (row.toolCallId
        ? vs.ops.slice().reverse().find((n) => n.toolCallId === row.toolCallId && (n.phase === "active" || n.phase === "approach"))
        : undefined
      ) ?? vs.ops.slice().reverse().find((n) => n.phase === "active" || n.phase === "approach")
      if (op) {
        op.phase = "complete"; op.doneAt = now
        spawnRipple(vs, 1, op.y / ch, op.rgb, 10)
        heatGate(vs, 1, 0.8); heatGate(vs, 2, 1.4)
      }
      break
    }
    case "tool-error": {
      const op = (row.toolCallId
        ? vs.ops.slice().reverse().find((n) => n.toolCallId === row.toolCallId && (n.phase === "active" || n.phase === "approach"))
        : undefined
      ) ?? vs.ops.slice().reverse().find((n) => n.phase === "active" || n.phase === "approach")
      if (op) {
        op.phase = "error"; op.doneAt = now
        spawnRipple(vs, 1, op.y / ch, [255, 60, 60], 14)
        heatGate(vs, 2, 0.8)
      }
      break
    }
    // Note: "info" kind is never produced by toTranscriptRow — no case needed.
    case "answer": {
      vs.answer = row.text; vs.streaming = false; vs.status = "completed"
      heatGate(vs, 3, 3.5)
      spawnRipple(vs, 3, 0.5, [200, 200, 200], 18)
      break
    }
    case "error": {
      vs.status = "failed"
      heatGate(vs, 3, 2.0)
      spawnRipple(vs, 3, 0.5, [255, 60, 60], 15)
      break
    }
    case "user-input": {
      heatGate(vs, 3, 1.0)
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onAnswer: (text: string) => void
}

export function VisualPane({ onAnswer }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const vsRef     = useRef<VS | null>(null)
  const [answer, setAnswer] = useState("")

  const transcript   = useStore((s) => s.transcript)
  const streaming    = useStore((s) => s.streamingAnswer)
  const runs         = useStore((s) => s.runs)
  const activeRunId  = useStore((s) => s.activeRunId)
  const pendingInput = useStore((s) => s.pendingInput)

  const txRef       = useRef(transcript)
  const streamRef   = useRef(streaming)
  const runsRef     = useRef(runs)
  const activeRef   = useRef(activeRunId)
  txRef.current     = transcript
  streamRef.current = streaming
  runsRef.current   = runs
  activeRef.current = activeRunId

  const events      = useStore((s) => s.events)
  const eventsRef   = useRef(events)
  const evtIdxRef   = useRef(0)
  eventsRef.current = events

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    function resize() {
      const parent = canvas!.parentElement
      if (!parent) return
      const dpr = window.devicePixelRatio || 1
      const w = parent.clientWidth  || window.innerWidth
      const h = parent.clientHeight || window.innerHeight
      canvas!.width  = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      canvas!.style.width  = w + "px"
      canvas!.style.height = h + "px"
      if (vsRef.current) {
        vsRef.current.pts = Array.from({ length: 160 }, () => spawnPt(w, h))
      }
    }
    resize()
    window.addEventListener("resize", resize)

    if (!vsRef.current) {
      const dpr0 = window.devicePixelRatio || 1
      vsRef.current = initVS(canvas.width / dpr0, canvas.height / dpr0)
      const ar = runsRef.current.find((r) => r.id === activeRef.current)
      if (ar) {
        vsRef.current.goal   = ar.goal
        vsRef.current.iter   = ar.llmCalls
        vsRef.current.tokens = ar.totalTokens
        vsRef.current.status = ar.status === "completed" ? "completed"
                             : ar.status === "failed"    ? "failed"
                             : ar.status === "running"   ? "running" : ""
        const ansRow = txRef.current.slice().reverse().find((r) => r.kind === "answer")
        if (ansRow) vsRef.current.answer = ansRow.text
      }
      vsRef.current.ingestedIdx = txRef.current.length
      evtIdxRef.current = eventsRef.current.length
    }

    let raf: number

    function tick() {
      raf = requestAnimationFrame(tick)
      if (!vsRef.current) return
      const dprLocal = window.devicePixelRatio || 1
      const cw = canvas!.width / dprLocal, ch = canvas!.height / dprLocal
      const vs = vsRef.current
      const now = performance.now()
      const dt  = Math.min((now - vs.lastMs) / 1000, 0.05)
      vs.lastMs = now; vs.t += dt

      // Detect run change — reset ingestion pointer when activeRunId changes
      const tx = txRef.current
      const nowRid = activeRef.current ?? ""
      if (nowRid !== vs.currentRunId) {
        vs.currentRunId = nowRid
        vs.ingestedIdx = 0
      } else if (tx.length < vs.ingestedIdx) {
        vs.ingestedIdx = 0  // safety: transcript was reset
      }

      // Ingest new transcript rows
      while (vs.ingestedIdx < tx.length) {
        ingestRow(vs, tx[vs.ingestedIdx]!, cw, ch)
        vs.ingestedIdx++
      }

      // Ingest debug.trace events for iter/token counts + LLM gate flashes
      const evts = eventsRef.current
      while (evtIdxRef.current < evts.length) {
        const e   = evts[evtIdxRef.current]!
        const aid = activeRef.current
        const rid = String(e.data["runId"] ?? "")
        if (e.type === "debug.trace" && (!aid || rid === aid)) {
          const entry = e.data["entry"] as Record<string, unknown> | undefined
          const kind  = entry?.["kind"] as string | undefined
          if (entry && kind === "iteration") {
            vs.iter = (entry["current"] as number | undefined) ?? vs.iter
          }
          if (entry && (kind === "llm-response" || kind === "usage")) {
            const u = (kind === "llm-response" ? entry["usage"] : entry) as { totalTokens?: number } | undefined
            if (u?.totalTokens) vs.tokens = u.totalTokens
            heatGate(vs, 2, 1.8)
            spawnRipple(vs, 2, 0.38 + Math.random() * 0.24, CAT_RGB.llm!, 11)
          }
          if (entry && kind === "llm-request") {
            const iter = entry["iteration"] as number | undefined
            if (iter != null) vs.iter = iter
            heatGate(vs, 2, 1.2)
          }
        }
        evtIdxRef.current++
      }

      // Streaming answer
      const s = streamRef.current
      if (s && s !== vs.answer) {
        vs.answer = s; vs.streaming = true
        heatGate(vs, 3, 0.4)
      } else if (!s && vs.streaming && vs.status === "completed") {
        vs.streaming = false
      }

      vs.toolsActive = vs.ops.filter((n) => n.phase === "approach" || n.phase === "active").length

      // Decay gate heat
      for (let i = 0; i < 4; i++) vs.gateHeat[i] = Math.max(0, vs.gateHeat[i]! - dt)

      // Thinking fade
      if (vs.thinkAlpha > 0) {
        const elapsed = (now - vs.thinkAt) / 1000
        if (elapsed > 6) vs.thinkAlpha = Math.max(0, vs.thinkAlpha - dt * 0.14)
      }

      // Advance ambient particles
      const halfW = cw * 0.5
      for (const p of vs.pts) {
        if (p.pinned) {
          if (now - p.pinnedAt > p.delay) { p.pinned = false; p.stage = p.stage < 3 ? p.stage + 1 : 4 }
          else if (p.stage < 4) { const yn = p.y / ch * 2 - 1; p.x = gateXAt(p.stage, yn, halfW, vs.t) - 0.5 }
          continue
        }
        p.x += p.spd * dt
        if (p.stage >= 4) {
          if (p.x > cw + 10) Object.assign(p, spawnPt(cw, ch))
        } else {
          const yn = p.y / ch * 2 - 1
          const gx = gateXAt(p.stage, yn, halfW, vs.t)
          if (p.x >= gx) { p.x = gx - 0.5; p.pinned = true; p.pinnedAt = now }
        }
      }

      // Advance op nodes
      for (const op of vs.ops) {
        if (op.phase === "approach") {
          const yn = op.y / ch * 2 - 1
          op.targetX = gateXAt(1, yn, halfW, vs.t)
          op.x      += (op.targetX - 10 - op.x) * Math.min(dt * 8.0, 1)  // fast snap
          if (op.x >= op.targetX - 11) op.phase = "active"
        } else if (op.phase === "active") {
          const yn = op.y / ch * 2 - 1
          op.x = gateXAt(1, yn, halfW, vs.t) - 2  // pinned at gate
        } else if (op.phase === "complete") {
          op.x += 22 * dt  // ambient speed — flows through LLM, OUT and off-screen
        } else if (op.phase === "error") {
          op.x += 60 * dt
        }
      }

      vs.ops     = vs.ops.filter((n) =>
        n.phase === "approach" || n.phase === "active" ||
        (n.phase === "complete" && n.x < cw + 20) ||
        (n.phase === "error" && (now - n.doneAt) < 1500)
      )
      vs.ripples = vs.ripples.filter((r) => (now - r.born) < 1600)

      ctx!.save()
      ctx!.scale(dprLocal, dprLocal)
      drawFrame(ctx!, cw, ch, vs, now)
      ctx!.restore()
    }

    tick()
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize) }
  }, [])

  const submitAnswer = useCallback(() => {
    const t = answer.trim()
    if (!t) return
    onAnswer(t); setAnswer("")
  }, [answer, onAnswer])

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, background: "#010203", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", position: "absolute", inset: 0 }}
      />

      {pendingInput && (
        <div style={ST_MODAL_BACKDROP}>
          <div style={ST_MODAL_BOX}>
            <div style={ST_MODAL_EYEBROW}>
              agent<span style={{ color: "rgba(160,255,220,.5)" }}>/</span>question
            </div>
            <div style={{ fontSize: 18, fontWeight: 300, color: "#fff", lineHeight: 1.6, marginBottom: 8 }}>
              {pendingInput.question}
            </div>
            {pendingInput.options && pendingInput.options.length > 0 && (
              <div style={{ fontSize: 9, letterSpacing: ".28em", color: "rgba(255,255,255,.22)",
                marginBottom: 32, textTransform: "uppercase", fontFamily: MONO }}>
                {pendingInput.options.join("  ·  ")}
              </div>
            )}
            {(!pendingInput.options || pendingInput.options.length === 0) && <div style={{ marginBottom: 32 }} />}
            <input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAnswer(); e.stopPropagation() }}
              style={ST_MODAL_INPUT}
              type={pendingInput.sensitive ? "password" : "text"}
              placeholder="—"
              autoComplete="off"
              spellCheck={false}
            />
            <div style={{ marginTop: 24, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 22 }}>
              <span style={{ fontSize: 7, letterSpacing: ".55em", color: "rgba(255,255,255,.1)",
                textTransform: "uppercase", fontFamily: MONO }}>enter</span>
              <button onClick={submitAnswer} style={ST_MODAL_BTN}>send →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const MONO = `ui-monospace,'Cascadia Code','JetBrains Mono','SF Mono',monospace`

const ST_MODAL_BACKDROP: CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(0,0,0,.72)", backdropFilter: "blur(6px)", zIndex: 50,
}
const ST_MODAL_BOX: CSSProperties = {
  width: "min(440px, 88vw)", padding: "48px 46px 42px",
  background: "rgba(1,2,4,.98)", border: "1px solid rgba(255,255,255,.06)",
  fontFamily: MONO,
}
const ST_MODAL_EYEBROW: CSSProperties = {
  fontSize: 7.5, letterSpacing: ".5em", color: "rgba(255,255,255,.15)",
  marginBottom: 24, textTransform: "uppercase",
}
const ST_MODAL_INPUT: CSSProperties = {
  display: "block", width: "100%", background: "none", border: "none",
  borderBottom: "1px solid rgba(255,255,255,.12)", outline: "none",
  padding: "8px 0", fontFamily: MONO, fontSize: 14,
  letterSpacing: ".05em", color: "#fff", caretColor: "#a0ffdc",
}
const ST_MODAL_BTN: CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  fontFamily: MONO, fontSize: 8.5, letterSpacing: ".45em",
  textTransform: "uppercase", color: "rgba(255,255,255,.30)", padding: "8px 0",
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas draw — called every frame
// ─────────────────────────────────────────────────────────────────────────────

const FONT = `"JetBrains Mono","Fira Code","IBM Plex Mono","Consolas","Menlo",monospace`

// ─────────────────────────────────────────────────────────────────────────────
// Answer text pre-processing
// ─────────────────────────────────────────────────────────────────────────────

/** Strip markdown inline syntax so it doesn't render literally on canvas. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // **bold**
    .replace(/\*([^*]+)\*/g, "$1")        // *italic*
    .replace(/__([^_]+)__/g, "$1")        // __bold__
    .replace(/_([^_]+)_/g, "$1")          // _italic_
    .replace(/`([^`]+)`/g, "$1")          // `code`
    .replace(/~~([^~]+)~~/g, "$1")        // ~~strike~~
    .replace(/^#{1,6}\s+/, "")            // # headings (strip #)
    .trim()
}

/**
 * Convert an answer string into canvas-ready display lines.
 * Respects hard newlines, formats markdown tables as "col · col",
 * strips markdown syntax, word-wraps to maxW pixels.
 */
function formatAnswer(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const out: string[] = []

  function wordWrap(str: string) {
    if (!str) return
    const words = str.split(" ")
    let line = ""
    for (const w of words) {
      if (!w) continue
      const test = line ? `${line} ${w}` : w
      if (ctx.measureText(test).width > maxW) { if (line) out.push(line); line = w } else line = test
    }
    if (line) out.push(line)
  }

  const rawLines = text.split("\n")
  let blankPending = false

  for (const raw of rawLines) {
    const trimmed = raw.trim()

    // Skip pure separator lines (---|---, ===, or |--|--|)
    if (trimmed && /^[\s|:=-]+$/.test(trimmed)) continue

    if (!trimmed) {
      blankPending = true
      continue
    }

    // Insert at most one blank between paragraphs (but not before the first line)
    if (blankPending && out.length > 0) out.push("")
    blankPending = false

    // Markdown table row: | col | col | ...
    if (trimmed.startsWith("|")) {
      const cols = trimmed
        .split("|")
        .map((c) => stripMd(c))
        .filter((c) => c.length > 0)
      if (cols.length >= 2) {
        // Two-col tables: "  name  ·  value" — clean key/value style
        const joined = cols.length === 2
          ? `  ${cols[0]}  ·  ${cols[1]}`
          : `  ${cols.join("  ·  ")}`
        wordWrap(joined)
        continue
      }
    }

    // List item: - text or * text
    if (/^[-*]\s+/.test(trimmed)) {
      wordWrap("· " + stripMd(trimmed.replace(/^[-*]\s+/, "")))
      continue
    }

    // Numbered list: 1. text
    if (/^\d+\.\s+/.test(trimmed)) {
      const m = trimmed.match(/^(\d+)\.\s+(.*)$/)
      if (m) wordWrap(`${m[1]}. ${stripMd(m[2]!)}`)
      continue
    }

    // Regular paragraph
    wordWrap(stripMd(trimmed))
  }

  // Remove leading/trailing blank lines
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()

  return out
}

function clipText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text
  let lo = 0, hi = text.length
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxPx) lo = mid; else hi = mid
  }
  return text.slice(0, lo) + "…"
}

function drawFrame(ctx: CanvasRenderingContext2D, cw: number, ch: number, vs: VS, now: number) {
  const halfW    = cw * 0.5
  // hasOutput: anything to show in the output block (answer text OR a terminal status)
  const hasOutput = !!(vs.answer || vs.streaming || vs.status === "completed" || vs.status === "failed")

  // Background
  ctx.fillStyle = "#010203"
  ctx.fillRect(0, 0, cw, ch)

  // Subtle scanline
  ctx.fillStyle = "rgba(0,0,0,.05)"
  for (let y = 0; y < ch; y += 4) ctx.fillRect(0, y, cw, 1)

  // ── Gate curves — clearly visible, brighter when active ──────────────────
  for (let s = 0; s < 4; s++) {
    const heat  = vs.gateHeat[s]!

    const base  = s === 1 || s === 2 ? 0.32 : 0.26
    const alpha = Math.min(base + heat * 0.40, 0.85)

    ctx.beginPath()
    for (let j = 0; j <= 120; j++) {
      const yn = j / 120 * 2 - 1
      const x  = gateXAt(s, yn, halfW, vs.t)
      const y  = j / 120 * ch
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    // LLM gate gets a hint of cyan when hot
    if (s === 2 && heat > 0.5) {
      ctx.strokeStyle = `rgba(160,255,220,${alpha.toFixed(3)})`
    } else {
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
    }
    ctx.lineWidth = heat > 0.5 ? 1.5 : 1; ctx.stroke()

    // Gate label
    const lx    = gateXAt(s, -0.92, halfW, vs.t)
    const heatN = Math.min(heat / 1.5, 1)
    const lBase = 0.48
    const lA    = lBase + heatN * 0.45
    ctx.font = `500 13px ${FONT}`; ctx.textAlign = "center"
    ctx.fillStyle = s === 2 ? `rgba(160,255,220,${lA.toFixed(3)})` : `rgba(255,255,255,${lA.toFixed(3)})`
    const cnt = vs.ops.filter((n) => n.phase === "approach" || n.phase === "active").length
    ctx.fillText(((s === 1 && cnt > 0) ? `${G_LABEL[s]}  ${cnt}` : G_LABEL[s]).toUpperCase(), lx, 22)
  }

  // ── Ripples ───────────────────────────────────────────────────────────────
  for (const rp of vs.ripples) {
    const age = (now - rp.born) / 1600
    if (age >= 1) continue
    const ease = 1 - age * age
    const a    = ease * ease * 0.42
    const gx   = gateXAt(rp.gateIdx, rp.yFrac * 2 - 1, halfW, vs.t)
    const gy   = rp.yFrac * ch
    ctx.beginPath(); ctx.arc(gx, gy, 4 + age * rp.maxR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rp.rgb[0]},${rp.rgb[1]},${rp.rgb[2]},${a.toFixed(3)})`
    ctx.lineWidth = 1.5; ctx.stroke()
  }

  // ── Ambient particles — neutral white, background texture only ─────────────
  for (const p of vs.pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.pinned ? 1.0 : 1.3, 0, Math.PI * 2)
    ctx.fillStyle = p.pinned ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.38)"
    ctx.fill()
  }

  // ── Op nodes (real tool calls) ────────────────────────────────────────────
  // Approach: bright labelled dot moving toward gate
  // Approach: yellow dot + label flying fast toward EXEC gate
  // Active:   yellow dot + label pinned at EXEC gate until done
  // Complete: morphs to small white ambient dot, flows through LLM→OUT→off-screen
  // Error:    expands red and fades
  ctx.save()
  for (const op of vs.ops) {
    const ageMs = now - op.born
    const [r, g, b] = op.rgb
    let alpha = 1, radius = 2.5
    let drawR = r, drawG = g, drawB = b

    if (op.phase === "approach") {
      alpha = 1.0; radius = 2.5
    } else if (op.phase === "active") {
      alpha = 1.0; radius = 2.5
    } else if (op.phase === "complete") {
      // Morph to white ambient dot — no fade until off-screen
      drawR = 255; drawG = 255; drawB = 255
      alpha = 0.42; radius = 1.3
    } else if (op.phase === "error") {
      const age = (now - op.doneAt) / 1500
      alpha = Math.max(0, 1 - age); radius = 4 + age * 5
      drawR = 255; drawG = 60; drawB = 60
    }
    if (alpha < 0.02) continue

    ctx.beginPath(); ctx.arc(op.x, op.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${drawR},${drawG},${drawB},${alpha.toFixed(3)})`
    ctx.fill()

    // Label during approach and active only
    if (op.phase === "approach" || op.phase === "active") {
      ctx.font = `500 13px ${FONT}`; ctx.textAlign = "left"
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`
      const text = clipText(ctx, op.label, cw - op.x - 28)
      ctx.fillText(text, op.x + radius + 10, op.y + 4)
    }
  }
  ctx.restore()

  // ── Thinking text — centred, clear ───────────────────────────────────────
  if (vs.thinkAlpha > 0.02 && vs.thinking) {
    const words = vs.thinking.split(" ")
    const lines: string[] = []
    let line = ""
    ctx.font = `400 13px ${FONT}`
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (ctx.measureText(test).width > cw * 0.62) { if (line) lines.push(line); line = w } else line = test
    }
    if (line) lines.push(line)
    const lh = 22; const startY = ch * 0.40 - (lines.length * lh) / 2
    ctx.textAlign = "center"
    lines.forEach((l, i) => {
      const a = Math.max(0, vs.thinkAlpha * (1 - i * 0.04) * 0.60)
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.fillText(l, cw * 0.5, startY + i * lh)
    })
  }

  // ── Terminal-style output — packed at bottom, no empty space ──────────────────
  // Renders from bottom up: answer lines → status → "> goal" prompt.
  // Veil is proportional — only as tall as content needs, max 40% of screen.
  if (vs.goal || hasOutput) {
    const PAD_X   = 40
    const PAD_B   = 24    // gap from canvas bottom
    const LH      = 22    // line height
    const FONT_SZ = "13px"

    // Format answer: respect newlines, strip markdown, wrap to canvas width
    const aLines: string[] = []
    if (hasOutput && vs.answer) {
      ctx.font = `${FONT_SZ} ${FONT}`
      const maxW = cw - PAD_X * 2
      aLines.push(...formatAnswer(ctx, vs.answer, maxW))
    }
    const MAXLINES = Math.max(1, Math.floor(ch * 0.40 / LH))
    const visible  = vs.streaming ? aLines.slice(0, MAXLINES) : aLines.slice(-MAXLINES)

    // Measure how tall the output block will be
    let blockH = PAD_B
    blockH += visible.length * LH          // answer lines
    if (hasOutput) blockH += LH * 1.5      // status/streaming indicator
    blockH += LH * 1.3                     // prompt line
    blockH += 48                           // veil fade-in headroom

    // Gradient veil — lightweight, proportional to content
    const veilTop = Math.max(ch - Math.min(blockH, ch * 0.45), ch * 0.55)
    const veil = ctx.createLinearGradient(0, veilTop, 0, ch)
    veil.addColorStop(0, "rgba(1,2,3,0)")
    veil.addColorStop(1, "rgba(1,2,3,0.68)")
    ctx.fillStyle = veil; ctx.fillRect(0, veilTop, cw, ch - veilTop)

    ctx.save()
    ctx.shadowColor = "rgba(0,0,0,0.92)"; ctx.shadowBlur = 5
    ctx.textAlign = "left"
    let curY = ch - PAD_B

    // Answer lines — bottom-most
    ctx.font = `${FONT_SZ} ${FONT}`
    for (let i = visible.length - 1; i >= 0; i--) {
      const isLast = vs.streaming && i === visible.length - 1
      if (visible[i] === "") {
        // blank paragraph separator — half-height gap
        curY -= Math.round(LH * 0.45)
        continue
      }
      const cursor = isLast && (now / 500 | 0) % 2 === 0 ? "▋" : ""
      ctx.fillStyle = "rgba(255,255,255,0.88)"
      ctx.fillText(visible[i]! + cursor, PAD_X, curY)
      curY -= LH
    }

    // Status / streaming indicator
    if (hasOutput) {
      if (vs.status === "completed") {
        ctx.font = `700 13px ${FONT}`
        ctx.fillStyle = "rgba(160,255,220,0.82)"
        ctx.fillText("DONE", PAD_X, curY)
      } else if (vs.status === "failed") {
        ctx.font = `700 13px ${FONT}`
        ctx.fillStyle = "rgba(255,80,80,0.82)"
        ctx.fillText("FAILED", PAD_X, curY)
      } else if (vs.streaming) {
        const blink = 0.42 + 0.28 * Math.sin(now / 380)
        ctx.font = `500 13px ${FONT}`
        ctx.fillStyle = `rgba(160,255,220,${blink.toFixed(3)})`
        ctx.fillText("▸", PAD_X, curY)
      }
      curY -= Math.round(LH * 1.5)
    }

    // "> goal" prompt line
    if (vs.goal) {
      ctx.font = `${FONT_SZ} ${FONT}`
      const prefix = "> "
      const prefW  = ctx.measureText(prefix).width
      const goalStr = clipText(ctx, vs.goal, cw - PAD_X * 2 - prefW)
      ctx.fillStyle = "rgba(160,255,220,0.52)"
      ctx.fillText(prefix, PAD_X, curY)
      ctx.fillStyle = "rgba(255,255,255,0.48)"
      ctx.fillText(goalStr, PAD_X + prefW, curY)
    }

    ctx.restore()
  }

  // ── Metrics — top-right, away from output zone ──────────────────────────
  ctx.save()
  ctx.textAlign = "right"
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4
  const mPad = 24
  let mY = 22
  ctx.font = `500 13px ${FONT}`
  if (vs.iter > 0) {
    ctx.fillStyle = "rgba(160,255,220,.72)"
    ctx.fillText(`ITER  ${vs.iter}`, cw - mPad, mY); mY += 18
  }
  if (vs.tokens > 0) {
    ctx.fillStyle = "rgba(255,255,255,.52)"
    ctx.fillText(`${(vs.tokens / 1000).toFixed(1)}k  tok`, cw - mPad, mY); mY += 18
  }
  if (vs.toolsActive > 0) {
    ctx.fillStyle = "rgba(255,255,255,.38)"
    ctx.fillText(`${vs.toolsActive}  tool${vs.toolsActive > 1 ? "s" : ""}  active`, cw - mPad, mY)
  }
  ctx.restore()

}
// (status badge removed — DONE/FAILED are always rendered inside the terminal block)

// =============================================================================
// FILE: components/Welcome.tsx
// =============================================================================

/**
 * Welcome — terminal wizard for first-visit identity capture.
 *
 * Reads as a tiny CLI session: the system prints a boot line, asks one
 * question, you type, you press Enter, the answer becomes scrollback and
 * the next question appears. When all fields are answered we POST to /api/me
 * via `onSubmit` and print "welcome, $name." before the modal dismisses.
 *
 * IDENTICAL COPIES live at:
 *   packages/ui-term/src/components/Welcome.tsx
 *   packages/ui/src/components/WelcomeModal.tsx
 *
 * Self-contained — literal colors, no CSS-var dependency — so it renders
 * the same in both apps regardless of host theme.
 *
 * Auth model: there is NO password. Admin trust comes from matching the
 * upn against AGENT001_ADMIN_UPNS on the server. AGENT001_ADMIN_PASSWORD is
 * an optional fallback that is currently unset, so we don't surface a
 * separate "admin login" entry — just type `admin` (or any whitelisted upn)
 * at the upn prompt to get full access.
 */

import { useEffect, useRef, useState } from "react"

interface Props {
  onSubmit: (displayName: string, upn: string) => Promise<void>
}

const BG       = "#0c0c10"
const BG_SOFT  = "#15151b"
const FG       = "#e4e4e7"
const FG_DIM   = "#a1a1aa"
const FG_MUTE  = "#6b6b78"
const ACCENT   = "#d8b4fe"
const ERROR    = "#f87171"
const FONT     = '"JetBrains Mono", "SFMono-Regular", "Consolas", "Menlo", monospace'

interface Answer { key: string; value: string }
type Step = "name" | "email" | "submitting" | "done"

export function Welcome({ onSubmit }: Props) {
  const [step, setStep]       = useState<Step>("name")
  const [draft, setDraft]     = useState("")
  const [answers, setAnswers] = useState<Answer[]>([])
  const [err, setErr]         = useState<string | null>(null)
  const inputRef              = useRef<HTMLInputElement>(null)
  const scrollRef             = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [step, answers.length])

  function recordAnswer(key: string, value: string) {
    setAnswers((a) => [...a, { key, value }])
    setDraft("")
    setErr(null)
  }

  async function commit(name: string, upn: string) {
    setStep("submitting")
    try {
      await onSubmit(name, upn)
      setAnswers((a) => [...a, { key: "·", value: `welcome, ${name}.` }])
      setStep("done")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setStep("email")
    }
  }

  function onEnter() {
    const value = draft.trim()
    if (step === "name") {
      if (!value) { setErr("name required"); return }
      recordAnswer("name", value)
      setStep("email")
    } else if (step === "email") {
      const display = value || "(none)"
      const name = answers.find((a) => a.key === "name")?.value ?? ""
      recordAnswer("email", display)
      void commit(name, value)
    }
  }

  const promptKey =
    step === "name" ? "name" :
    step === "email"  ? "email"  : "·"

  const promptHint =
    step === "name"       ? "your display name" :
    step === "email"        ? "your email — leave blank to skip" :
    step === "submitting" ? "saving…" : ""

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: BG, color: FG, fontFamily: FONT,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 620 }}>
        <div style={{ color: FG_DIM, fontSize: 13, marginBottom: 14 }}>
          agent<span style={{ color: ACCENT }}>001</span>
          <span style={{ color: FG_MUTE }}>{"  //  "}</span>
          identity setup
        </div>

        <div
          ref={scrollRef}
          style={{
            maxHeight: "40vh", overflowY: "auto",
            paddingBottom: 8, fontSize: 14, lineHeight: 1.7,
          }}
        >
          {answers.map((a, i) => (
            <div key={i}>
              <span style={{ color: FG_MUTE, marginRight: 8 }}>›</span>
              <span style={{ color: FG_DIM }}>{a.key}</span>
              <span style={{ color: FG_MUTE }}>: </span>
              <span style={{ color: FG }}>{a.value}</span>
            </div>
          ))}
        </div>

        {step === "done" ? null : (
          <div style={{ marginTop: 4 }}>
            {promptHint ? (
              <div style={{ color: FG_MUTE, fontSize: 12, marginBottom: 4, marginLeft: 22 }}>
                {promptHint}
              </div>
            ) : null}
            <div
              style={{
                display: "flex", alignItems: "baseline", gap: 8,
                background: BG_SOFT, padding: "10px 12px",
                fontSize: 15,
              }}
            >
              <span style={{ color: ACCENT }}>›</span>
              <span style={{ color: FG_DIM, minWidth: 42 }}>{promptKey}</span>
              <span style={{ color: FG_MUTE }}>›</span>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); if (err) setErr(null) }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter() } }}
                disabled={step === "submitting"}
                spellCheck={false}
                autoComplete="off"
                style={{
                  flex: 1, color: FG, background: "transparent",
                  border: 0, outline: "none", font: "inherit", padding: 0,
                  caretColor: ACCENT,
                }}
              />
            </div>
          </div>
        )}

        <div style={{ marginTop: 10, marginLeft: 22, fontSize: 12, color: FG_MUTE, minHeight: "1.4em" }}>
          {err ? <span style={{ color: ERROR }}>! {err}</span>
            : step === "done" ? <span style={{ color: ACCENT }}>— ready —</span>
            : <>press <kbd style={kbd}>Enter</kbd> to continue</>}
        </div>
      </div>
    </div>
  )
}

const kbd: React.CSSProperties = {
  color: ACCENT,
  background: BG_SOFT,
  padding: "1px 6px",
  borderRadius: 3,
  fontFamily: FONT,
  fontSize: 11,
}

// =============================================================================
// FILE: components/WelcomeIntro.tsx
// =============================================================================

/**
 * WelcomeIntro — agent001 boot animation, in the term-UI palette.
 *
 * Concept (rewritten):
 *   The overlay starts as a solid `--bg` covering the live shell. The
 *   wordmark `agent001` decodes left-to-right (per-letter scramble →
 *   lock) in a single colour. A thin progress bar materialises and
 *   fills with lavender. As soon as it tops out, the cover IS the
 *   mosaic — it's secretly a grid of `--bg` tiles — and each tile
 *   snaps to invisible (no fade, hard cut) on a delay schedule from
 *   centre OUTWARD, literally uncovering the live shell underneath
 *   piece by piece. The wordmark + bar disappear with their tiles.
 *
 *   No hardcoded colors. No flash. No pulse. No idle motion.
 *   No fading: tiles snap. The shell is genuinely uncovered.
 *
 * Timeline (~3.5s):
 *   0.00s  solid black cover, wordmark area empty
 *   0.55s  letter stream begins — ~110ms / letter
 *   1.45s  word "agent001" locked (single colour, no accent)
 *   1.65s  bar track materialises (200ms)
 *   2.07s  bar fill sweeps left → right (650ms)
 *   2.72s  bar full — tiles begin snapping off, centre first
 *   2.72s  outward wave, ~700ms across all tiles, ~80ms per tile snap
 *   ~3.5s  last edge tile snaps; shell fully uncovered; unmount
 *
 * Skip: any key (Esc/Space/Enter) or click → 250ms fade.
 * Reduced motion: instant exit.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

interface Props {
  onDone: () => void
  durationMs?: number
}

// Pixel mosaic resolution. Higher = finer texture, more DOM nodes.
const COLS = 36
const ROWS = 20

// ── Streamed wordmark configuration ──────────────────────────────────────
const WORD = "agent001"
const SCRAMBLE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*<>?/+="

const STREAM_REVEAL_MS    = 550
const LETTER_STEP_MS      = 110
const SCRAMBLE_DURATION_MS= 90
const SCRAMBLE_TICK_MS    = 50
const STREAM_END_MS = STREAM_REVEAL_MS + (WORD.length - 1) * LETTER_STEP_MS + SCRAMBLE_DURATION_MS

const BAR_DOTS = 28
// Bar appears shortly after wordmark locks.
const BAR_GEN_START_MS    = STREAM_END_MS + 50            // ~1450ms
const BAR_GEN_DURATION_MS = 200
// Small wait between track materialising and fill beginning — lets the
// eye register the empty track before it starts filling.
const BAR_FILL_START      = BAR_GEN_START_MS + BAR_GEN_DURATION_MS + 220   // ~2070ms
const BAR_FILL_DURATION   = 650

// As soon as the bar tops out, each tile of the cover snaps to invisible
// (hard cut, no fade) on a centre-OUTWARD delay schedule. The shell
// underneath is literally uncovered piece by piece.
const BAR_END_AT      = BAR_FILL_START + BAR_FILL_DURATION   // ~2720ms
const COMPOSE_OUT     = BAR_END_AT                           // wordmark+bar exit with their tiles
const DISSOLVE_AT     = BAR_END_AT                           // tile snapping begins now
const DISSOLVE_SPREAD = 700                                  // window over which the wave travels
const REVEAL_END      = DISSOLVE_AT + DISSOLVE_SPREAD + 100  // ~3520ms

function randomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % SCRAMBLE_ALPHABET.length)
  return SCRAMBLE_ALPHABET[i]
}

type LetterState = "hidden" | "scrambling" | "locked"
interface LetterCell { state: LetterState; glyph: string }

export function WelcomeIntro({ onDone, durationMs = 3600 }: Props) {
  const [skipping, setSkipping] = useState(false)
  const [cells, setCells] = useState<LetterCell[]>(
    () => WORD.split("").map(() => ({ state: "hidden", glyph: "" })),
  )
  const [justLocked, setJustLocked] = useState<boolean[]>(
    () => WORD.split("").map(() => false),
  )
  const startedAtRef = useRef<number>(performance.now())

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone(); return
    }
    const startedAt = startedAtRef.current
    const doneAt = window.setTimeout(onDone, durationMs)

    let raf = 0
    let lastTick = 0
    const flashed = new Set<number>()
    const tick = (now: number) => {
      const elapsed = now - startedAt
      if (elapsed > STREAM_END_MS + 600) return
      if (now - lastTick < SCRAMBLE_TICK_MS) {
        raf = requestAnimationFrame(tick); return
      }
      lastTick = now
      const newlyLocked: number[] = []
      setCells((prev) => {
        const next = prev.slice()
        for (let i = 0; i < WORD.length; i++) {
          const revealAt = STREAM_REVEAL_MS + i * LETTER_STEP_MS
          const lockAt = revealAt + SCRAMBLE_DURATION_MS
          if (elapsed < revealAt) continue
          if (elapsed >= lockAt) {
            if (next[i].state !== "locked") {
              next[i] = { state: "locked", glyph: WORD[i] }
              if (!flashed.has(i)) { flashed.add(i); newlyLocked.push(i) }
            }
          } else {
            next[i] = { state: "scrambling", glyph: randomGlyph(Math.floor(now) + i * 17) }
          }
        }
        return next
      })
      if (newlyLocked.length > 0) {
        setJustLocked((prev) => {
          const next = prev.slice()
          for (const i of newlyLocked) next[i] = true
          return next
        })
        window.setTimeout(() => {
          setJustLocked((prev) => {
            const next = prev.slice()
            for (const i of newlyLocked) next[i] = false
            return next
          })
        }, 280)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const skip = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== " " && e.key !== "Enter") return
      window.clearTimeout(doneAt)
      cancelAnimationFrame(raf)
      setSkipping(true)
      window.setTimeout(onDone, 250)
    }
    window.addEventListener("keydown", skip)
    return () => {
      window.clearTimeout(doneAt)
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", skip)
    }
  }, [durationMs, onDone])

  // Pre-compute mosaic cells with deterministic pseudo-random properties:
  // each cell gets a phase offset for the breathing animation, a
  // distance-from-centre value for the outward dissolve, and a one-bit
  // "is-accent" flag (~12% of tiles) so a few sparkle in lavender.
  const mosaicCells = useMemo(() => {
    const total = COLS * ROWS
    const cx = (COLS - 1) / 2
    const cy = (ROWS - 1) / 2
    const maxDist = Math.hypot(cx, cy)
    const arr: { c: number; r: number; phase: number; dist: number; accent: boolean }[] = new Array(total)
    for (let i = 0; i < total; i++) {
      const c = i % COLS
      const r = Math.floor(i / COLS)
      const j1 = Math.abs((Math.sin(c * 12.9898 + r * 78.233) * 43758.5453) % 1)
      const j2 = Math.abs((Math.sin(c * 39.346 + r * 11.135) * 21731.95) % 1)
      const dist = Math.hypot(c - cx, r - cy) / maxDist            // 0..1
      arr[i] = { c, r, phase: j1, dist, accent: j2 < 0.12 }
    }
    return arr
  }, [])

  const barTrackDelays = useMemo(
    () => Array.from({ length: BAR_DOTS }, (_, i) => {
      const j = Math.abs((Math.sin(i * 91.31 + 13.7) * 9999) % 1)
      return BAR_GEN_START_MS + j * BAR_GEN_DURATION_MS
    }),
    [],
  )

  return createPortal(
    <div
      className={`a001-intro ${skipping ? "a001-intro-skip" : ""}`}
      onClick={() => { setSkipping(true); window.setTimeout(onDone, 250) }}
      role="presentation"
      aria-hidden="true"
    >
      {/* ── Mosaic field ──────────────────────────────────────
          Dim cells over the dark canvas. Most idle in zinc, a few in
          lavender. They breathe in/out continuously, then a "settled"
          pulse brightens everything once, then they dissolve outward
          from the centre to expose the live shell underneath. */}
      {/* ── Mosaic cover ─────────────────────────────
          A grid of solid --bg tiles that together form a seamless cover
          over the live shell. When the dissolve phase begins, each tile
          snaps to invisible (hard cut, no fade) on a centre-outward
          delay schedule — literally uncovering the page beneath. */}
      <div className="a001-mosaic" aria-hidden="true">
        {mosaicCells.map(({ c, r, phase, dist }, i) => {
          // Centre (dist=0) goes first, edges (dist=1) last. Plus a
          // small per-cell jitter so the wave isn't a perfect ring.
          const snapDelay = DISSOLVE_AT + dist * DISSOLVE_SPREAD + phase * 90
          return (
            <span
              key={i}
              className="a001-mosaic-cell"
              style={{
                gridColumn: c + 1,
                gridRow: r + 1,
                animation: `a001-cell-snap 1ms steps(1) ${snapDelay}ms forwards`,
              }}
            />
          )
        })}
      </div>

      {/* ── Composition: wordmark + progress bar ─────────────── */}
      <div
        className="a001-term"
        style={{
          // Wordmark+bar are absorbed under the collapsing mosaic — they
          // exit on the same timing as the dissolve begins.
          animation:
            `a001-term-in  500ms ease-out 400ms forwards,
             a001-term-out 320ms ease-in ${COMPOSE_OUT}ms forwards`,
        }}
      >
        <span className="a001-word" aria-label="agent001">
          {cells.map((cell, i) => (
            <span
              key={i}
              className={[
                "a001-letter",
                // Single colour throughout — no per-letter accent.
                cell.state === "scrambling" ? "a001-letter-scramble" : "",
                cell.state === "locked" ? "a001-letter-locked" : "",
              ].join(" ")}
            >
              {cell.state === "hidden" ? "\u00A0" : cell.glyph}
            </span>
          ))}
        </span>
        <span className="a001-term-bar" aria-hidden="true">
          <span className="a001-term-bar-cells">
            <span className="a001-term-bar-track">
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span
                  key={i}
                  className="a001-term-bar-cell"
                  style={{
                    animation: `a001-bar-cell-in 220ms ease-out ${barTrackDelays[i]}ms forwards`,
                  }}
                />
              ))}
            </span>
            <span
              className="a001-term-bar-fill"
              style={{
                animation: `a001-bar-fill ${BAR_FILL_DURATION}ms cubic-bezier(.65,.0,.35,1) ${BAR_FILL_START}ms forwards`,
              }}
            >
              {Array.from({ length: BAR_DOTS }).map((_, i) => (
                <span key={i} className="a001-term-bar-cell a001-term-bar-cell-on" />
              ))}
            </span>
          </span>
        </span>
      </div>

      {/* Hint — appears late, gives the user a clue they can skip. */}
      <span className="a001-hint">press any key to skip</span>

      <style>{`
        .a001-intro {
          position: fixed; inset: 0; z-index: 9999;
          /* No background here — the mosaic tiles ARE the cover. The
             container stays transparent so as tiles snap off, the
             live shell behind is genuinely uncovered. */
          background: transparent;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          opacity: 1;
          font-family: var(--font-mono);
        }
        .a001-intro-skip { animation: a001-intro-skip 250ms linear forwards !important; }
        @keyframes a001-intro-skip { to { opacity: 0; } }

        /* ── Pixel mosaic cover ─────────────────────────────────── */
        .a001-mosaic {
          position: absolute; inset: 0;
          display: grid;
          grid-template-columns: repeat(${COLS}, 1fr);
          grid-template-rows:    repeat(${ROWS}, 1fr);
          /* Zero gap so the tiles form a seamless cover — no visible
             grid lines until they begin snapping off. */
          gap: 0;
          pointer-events: none;
          z-index: 1;
        }
        .a001-mosaic-cell {
          background: var(--bg);
          opacity: 1;
          will-change: opacity;
        }
        /* Hard cut — no fade. Each tile literally disappears, uncovering
           a piece of the live shell behind. */
        @keyframes a001-cell-snap {
          to { opacity: 0; }
        }

        /* ── Composition (wordmark + bar) ─────────────────────── */
        .a001-term {
          position: absolute;
          left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          display: flex; align-items: center;
          gap: 28px;
          opacity: 0;
          will-change: opacity;
          z-index: 2;
          font-weight: 600;
          font-size: clamp(22px, 2.8vw, 38px);
          letter-spacing: 0.06em;
          color: var(--fg);
        }
        @keyframes a001-term-in  { to { opacity: 1; } }
        @keyframes a001-term-out { to { opacity: 0; } }

        /* ── Streamed wordmark ────────────────────────────────── */
        .a001-word {
          display: inline-flex;
          white-space: nowrap;
        }
        .a001-letter {
          display: inline-block;
          width: 0.62em;
          text-align: center;
          color: var(--fg);
          transition: color 80ms linear;
        }
        .a001-letter-scramble {
          color: var(--fg-mute);
          opacity: 0.7;
        }
        .a001-letter-locked {
          color: var(--fg);
        }
        /* No accent, no flash, no glow on lock — single colour throughout. */

        /* ── Progress bar ─────────────────────────────────────── */
        .a001-term-bar {
          display: inline-flex;
          align-items: center;
        }
        .a001-term-bar-cells {
          position: relative;
          display: inline-block;
          width: calc(${BAR_DOTS} * 0.5em);
          height: 0.6em;
          overflow: hidden;
        }
        .a001-term-bar-track,
        .a001-term-bar-fill {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: stretch;
          gap: 2px;
        }
        .a001-term-bar-cell {
          flex: 1 1 0;
          height: 100%;
          background: var(--bg-soft);
          opacity: 0;
        }
        @keyframes a001-bar-cell-in { to { opacity: 1; } }
        .a001-term-bar-cell-on {
          background: var(--accent-dim);
          opacity: 1;
        }
        .a001-term-bar-fill {
          clip-path: inset(0 100% 0 0);
          will-change: clip-path;
        }
        @keyframes a001-bar-fill { to { clip-path: inset(0 0 0 0); } }

        /* ── Skip hint ────────────────────────────────────────── */
        .a001-hint {
          position: absolute;
          bottom: 28px; left: 50%;
          transform: translateX(-50%);
          color: var(--fg-mute);
          font-size: var(--fs-xs);
          letter-spacing: 0.18em;
          text-transform: uppercase;
          opacity: 0;
          z-index: 2;
          animation: a001-hint-in 800ms ease-out 2400ms forwards,
                     a001-hint-out 500ms ease-in ${COMPOSE_OUT}ms forwards;
        }
        @keyframes a001-hint-in  { to { opacity: 0.5; } }
        @keyframes a001-hint-out { to { opacity: 0; } }

        @media (prefers-reduced-motion: reduce) {
          .a001-intro, .a001-term, .a001-term-bar-fill,
          .a001-mosaic-cell, .a001-letter, .a001-hint {
            animation: none !important; opacity: 0 !important;
          }
        }
      `}</style>
    </div>,
    document.body,
  )
}

// =============================================================================
// FILE: App.tsx
// =============================================================================

/**
 * Term-UI shell.
 *
 * Layout:
 *
 *   ┌──────────────── StatusBar ────────────────────────────────────┐
 *   │ STREAM (active run)         │ OPERATIONS (unified ops log)    │
 *   │                             │                                 │
 *   │                             │                                 │
 *   ├─────────────────────────────┴─────────────────────────────────┤
 *   │ > goal prompt                                                 │
 *   ├──────────────── HelpBar ──────────────────────────────────────┤
 *
 * Two panes, focusable via [1]/[2]; `/` focuses the log filter; `:`
 * focuses the goal prompt; Esc bubbles up to clear or unfocus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, createEventStream } from "./api"
import { buildCommands, matchSlash, slashSuggestions, type Command } from "./commands"
import { AdminLogin } from "./components/AdminLogin"
import { CommandPalette } from "./components/CommandPalette"
import { GoalInput, type GoalInputHandle } from "./components/GoalInput"
import { LogPane, type LogPaneHandle } from "./components/LogPane"
import { RunPicker } from "./components/RunPicker"
import { StatusBar } from "./components/StatusBar"
import { StreamPane, type StreamPaneHandle } from "./components/StreamPane"
import { VisualPane } from "./components/VisualPane"
import { Welcome } from "./components/Welcome"
import { WelcomeIntro } from "./components/WelcomeIntro"
import { isMeta, useGlobalKeybinds } from "./keybinds"
import { useStore } from "./store"
import { setUiShell, urlForShell } from "./uiPref"
import { useMe } from "./useMe"

type Pane = "stream" | "log"
type ViewMode = "tui" | "visual"

export function App() {
  const { me, needsWelcome, setIdentity, switchUser, refresh } = useMe()
  const [adminOpen, setAdminOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [introDone, setIntroDone] = useState(false)
  const [focused, setFocused] = useState<Pane>("stream")
  const [viewMode, setViewMode] = useState<ViewMode>("tui")
  const toggleView = useCallback(() => setViewMode((v) => v === "tui" ? "visual" : "tui"), [])

  const connected     = useStore((s) => s.connected)
  const setConnected  = useStore((s) => s.setConnected)
  const pushEvent     = useStore((s) => s.pushEvent)
  const events        = useStore((s) => s.events)
  const transcript    = useStore((s) => s.transcript)
  const streaming     = useStore((s) => s.streamingAnswer)
  const runs          = useStore((s) => s.runs)
  const activeRunId   = useStore((s) => s.activeRunId)
  const setActiveRun  = useStore((s) => s.setActiveRun)
  const resetTranscript = useStore((s) => s.resetTranscript)
  const setRuns       = useStore((s) => s.setRuns)
  const pendingInput  = useStore((s) => s.pendingInput)
  const clearPending  = useStore((s) => s.clearPendingInput)

  const goalRef   = useRef<GoalInputHandle>(null)
  const logRef    = useRef<LogPaneHandle>(null)
  const streamRef = useRef<StreamPaneHandle>(null)

  // ── Identity-bound SSE subscription ──
  useEffect(() => {
    const stream = createEventStream(pushEvent, setConnected)
    return () => stream.close()
  }, [pushEvent, setConnected, me?.sessionId])

  // ── Initial run list + event backfill ──
  useEffect(() => {
    if (!me) return
    // Backfill recent ops events first so the right pane isn't empty on a fresh
    // reload — SSE only delivers NEW envelopes; the persisted event log holds
    // the last N for replay.
    api.recentEvents(500).then(({ events }) => {
      // Server returns newest-first; replay oldest-first so the operations
      // pane reads chronologically (oldest at top, newest at bottom).
      for (let i = events.length - 1; i >= 0; i--) pushEvent(events[i]!)
    }).catch(() => { /* non-fatal */ })

    api.listRuns().then((rs) => {
      setRuns(rs)
      if (rs.length && !activeRunId) {
        const latest = rs[0]!
        setActiveRun(latest.id)
        // Hydrate transcript from server for the latest run
        api.getRun(latest.id).then((detail) => {
          // Replay run's logs as synthetic WsEvents so transcript builds
          for (const log of detail.logs ?? []) {
            pushEvent({
              type: log.eventName ?? log.type,
              data: log.data ?? { runId: latest.id, message: log.message },
              timestamp: log.timestamp,
            })
          }
        }).catch(() => { /* non-fatal */ })
      }
    }).catch(() => { /* non-fatal */ })
  }, [me?.sessionId, setRuns, setActiveRun, pushEvent, activeRunId])

  // Active run snapshot
  const activeRun = useMemo(
    () => runs.find((r) => r.id === activeRunId) ?? null,
    [runs, activeRunId],
  )
  const busy = !!activeRun && (activeRun.status === "running" || activeRun.status === "pending")

  // ── Answer to ask_user (used by both TUI banner and VisualPane modal) ──
  const onAnswer = useCallback(async (text: string) => {
    if (!pendingInput) return
    try { await api.respondToRun(pendingInput.runId, text) }
    finally { clearPending() }
  }, [pendingInput, clearPending])

  // ── Submit handler — slash command, ask_user response, or new run ──
  // commandsRef avoids a TDZ cycle: this callback resolves slash commands
  // through the registry, but the registry is built further down.
  const commandsRef = useRef<Command[]>([])
  const onSubmitGoal = useCallback(async (text: string) => {
    // Slash commands resolve through the central registry.
    const slashCmd = matchSlash(text, commandsRef.current)
    if (slashCmd) { void slashCmd.run(); return }
    // Lone "/" or unrecognised slash → open the palette pre-filled.
    if (text.trim().startsWith("/")) {
      setPaletteOpen(true)
      return
    }

    if (pendingInput) {
      try { await api.respondToRun(pendingInput.runId, text) }
      finally { clearPending() }
      return
    }

    if (busy) {
      pushEvent({
        type: "ui.notice",
        timestamp: new Date().toISOString(),
        data: { runId: activeRunId, message: "a run is still active \u2014 type /cancel (or Ctrl+.) to abort it before starting a new one." },
      })
      return
    }

    try {
      const { runId } = await api.startRun(text)
      resetTranscript(runId); setActiveRun(runId)
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { message: e instanceof Error ? e.message : String(e) } })
    }
  }, [pendingInput, clearPending, resetTranscript, setActiveRun, pushEvent, activeRunId, busy])

  // ── Open a specific run (used by RunPicker) ──
  const openRun = useCallback((id: string) => {
    resetTranscript(id)
    setActiveRun(id)
    api.getRun(id).then((detail) => {
      for (const log of detail.logs ?? []) {
        pushEvent({
          type: log.eventName ?? log.type,
          data: log.data ?? { runId: id, message: log.message },
          timestamp: log.timestamp,
        })
      }
    }).catch(() => { /* non-fatal */ })
  }, [resetTranscript, setActiveRun, pushEvent])

  // Cancel the active run (used by StatusBar [abort], Ctrl+., /cancel).
  const abortActive = useCallback(() => {
    if (!activeRunId) return
    api.cancelRun(activeRunId).catch((e) => {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    })
  }, [activeRunId, pushEvent])

  const rerunActive = useCallback(async () => {
    if (!activeRunId) {
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { message: "no run to rerun" } })
      return
    }
    try {
      const { runId } = await api.rerunRun(activeRunId)
      resetTranscript(runId); setActiveRun(runId)
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    }
  }, [activeRunId, resetTranscript, setActiveRun, pushEvent])

  const rollbackActive = useCallback(async () => {
    if (!activeRunId) return
    try {
      const preview = await api.previewRollback(activeRunId)
      const n = preview.effectCount ?? preview.effects?.length ?? 0
      if (n === 0) {
        pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: "no reversible effects on this run" } })
        return
      }
      const ok = window.confirm(`Rollback ${n} effect${n === 1 ? "" : "s"} from run ${activeRunId.slice(0, 7)}?`)
      if (!ok) return
      const result = await api.rollbackRun(activeRunId)
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `rolled back ${result.reverted ?? n} effect(s)` } })
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    }
  }, [activeRunId, pushEvent])

  const exportTrace = useCallback(async () => {
    if (!activeRunId) return
    const run = runs.find((r) => r.id === activeRunId)
    try {
      const entries = await api.getRunTrace(activeRunId)
      const lines: string[] = []
      const ts = new Date().toISOString().slice(0, 19).replace("T", " ")
      lines.push(`agent-loop trace  run=${activeRunId}  exported=${ts}`)
      if (run?.goal) lines.push(`goal: ${run.goal}`)
      lines.push(`status: ${run?.status ?? "unknown"}  tokens: ${run?.totalTokens ?? "?"}  llm_calls: ${run?.llmCalls ?? "?"}`)
      lines.push("=" .repeat(72))
      lines.push("")
      for (const e of entries) {
        const kind = String(e.kind ?? "?")
        const p = "  "
        switch (kind) {
          case "goal":           lines.push(`GOAL  ${e.text ?? ""}`); break
          case "system-prompt":  lines.push(`SYSTEM PROMPT\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "tools-resolved": {
            const tools = (e.tools as Array<{ name?: string }> | undefined) ?? []
            lines.push(`TOOLS  ${tools.length}: ${tools.map((t) => t.name).join(", ")}`)
            break
          }
          case "iteration":      lines.push(`ITERATION ${e.current}/${e.max}`); break
          case "thinking":       lines.push(`THINKING\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "tool-call":      lines.push(`TOOL CALL  ${e.tool}  ${e.argsSummary ?? ""}\n${p}${String(e.argsFormatted ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "tool-result":    lines.push(`TOOL RESULT\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "tool-error":     lines.push(`TOOL ERROR\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "answer":         lines.push(`ANSWER\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "error":          lines.push(`ERROR\n${p}${String(e.text ?? "").replace(/\n/g, `\n${p}`)}`); break
          case "usage":          lines.push(`USAGE  +${e.iterationTokens ?? 0} tk · total ${e.totalTokens ?? 0} · ${e.llmCalls ?? 0} calls`); break
          case "llm-request":    lines.push(`LLM REQUEST  ${e.messageCount ?? "?"} msgs · ${e.toolCount ?? 0} tools  (iter ${e.iteration ?? "?"})`); break
          case "llm-response":   lines.push(`LLM RESPONSE  ${e.durationMs ?? "?"}ms  ${(e.usage as { totalTokens?: number } | undefined)?.totalTokens ?? "?"} tok  ${(e.toolCalls as unknown[])?.length ?? 0} calls`); break
          case "planner-decision": lines.push(`PLANNER  ${e.shouldPlan ? "activated" : "skipped"}  score ${Number(e.score).toFixed(2)}  route=${e.route ?? "-"}  coherence=${e.coherenceNeed ?? "-"}  coordination=${e.coordinationNeed ?? "-"}`); break
          case "planner-step-start": lines.push(`STEP  ${e.stepName}  ${e.stepType}`); break
          case "planner-step-end":   lines.push(`STEP END  ${e.stepName}  ${e.status}${e.durationMs != null ? `  ${e.durationMs}ms` : ""}`); break
          case "planner-pipeline-start": lines.push(`PIPELINE START  attempt ${e.attempt}/${e.maxRetries}`); break
          case "planner-pipeline-end":   lines.push(`PIPELINE END  ${e.status}  ${e.completedSteps}/${e.totalSteps} steps`); break
          case "delegation-start": lines.push(`DELEGATE${e.agentName ? ` [${e.agentName}]` : ""}\n${p}${e.goal ?? ""}`); break
          case "delegation-iteration": lines.push(`DELEGATE ITER ${e.iteration}/${e.maxIterations}`); break
          case "delegation-end":  lines.push(`DELEGATE END  ${e.status}\n${p}${String(e.answer ?? e.error ?? "").slice(0, 400)}`); break
          case "user-input-request": lines.push(`ASK USER  ${e.question ?? ""}`); break
          case "user-input-response": lines.push(`USER REPLY  ${e.text ?? ""}`); break
          case "nudge":          lines.push(`NUDGE [${e.tag ?? ""}]  ${e.message ?? ""}`); break
          default:               lines.push(`${kind}  ${JSON.stringify(e).slice(0, 120)}`); break
        }
      }
      if (entries.length === 0) lines.push("(no trace entries recorded for this run)")
      const text = lines.join("\n")
      const slug = activeRunId.slice(0, 8)
      const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const filename = `agent-loop-${dateTag}-${slug}.txt`
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `downloaded ${filename}  (${entries.length} trace entries)` } })
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `trace export failed: ${e instanceof Error ? e.message : String(e)}` } })
    }
  }, [activeRunId, runs, pushEvent])

  const flagAnswer = useCallback(async () => {
    if (!activeRunId) return
    try {
      const result = await api.flagAnswer(activeRunId)
      const msg = result.action === "flagged"
        ? "answer flagged as unhelpful \u2014 memory down-weighted, agent will avoid this approach next time"
        : result.action === "no_memory_entry"
          ? "no episodic memory entry found for this run (may still be indexing)"
          : "flagged"
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: msg } })
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `flag failed: ${e instanceof Error ? e.message : String(e)}` } })
    }
  }, [activeRunId, pushEvent])

  // ── Command registry ── single source of truth for keybinds, slash, palette.
  const commands: Command[] = useMemo(() => buildCommands({
    ctx: { busy, activeRunId, hasPendingInput: !!pendingInput },
    openPalette:    () => setPaletteOpen(true),
    openRunPicker:  () => setPickerOpen(true),
    openAdmin:      () => setAdminOpen(true),
    focusStream:    () => { setFocused("stream"); window.requestAnimationFrame(() => streamRef.current?.focus()) },
    focusLog:       () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.focusScroll()) },
    focusFilter:    () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.focusFilter()) },
    followLog:      () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.toggleFollow()) },
    jumpToBottom:   () => focused === "log" ? logRef.current?.jumpToBottom() : streamRef.current?.jumpToBottom(),
    focusPrompt:    () => window.requestAnimationFrame(() => goalRef.current?.focus()),
    clearFilter:    () => logRef.current?.clearFilter(),
    abortRun:       abortActive,
    rerunRun:       rerunActive,
    rollbackRun:    rollbackActive,
    exportTrace,
    flagAnswer,
    switchUser,
    switchUi:       () => { setUiShell("classic"); window.location.assign(urlForShell("classic")) },
    toggleView,
  }), [busy, activeRunId, pendingInput, focused, abortActive, rerunActive, rollbackActive, exportTrace, flagAnswer, switchUser, toggleView])
  commandsRef.current = commands

  // ── Keybinds ── a thin glue layer; everything dispatches through commands.
  const handleKey = useCallback((key: string, ev: KeyboardEvent) => {
    // Esc: blur whatever is focused (works from inputs).
    if (key === "Escape") {
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) { ae.blur(); return true }
      return false
    }
    // "?" opens the palette (only when not typing in an input).
    if (key === "?") {
      const ae = document.activeElement as HTMLElement | null
      const inField = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")
      if (!inField) { setPaletteOpen(true); return true }
      return false
    }
    // Everything else needs Ctrl.
    if (!isMeta(ev)) return false
    if (key === "k" || key === "K") { setPaletteOpen(true); return true }

    // Resolve registry-driven keybinds.
    const want = `${ev.ctrlKey ? "Ctrl+" : ""}${key.length === 1 ? key.toUpperCase() : key}`
    for (const cmd of commands) {
      if (cmd.keybind && cmd.keybind === want) { void cmd.run(); return true }
    }
    return false
  }, [commands])
  useGlobalKeybinds(handleKey)

  // Auto-focus prompt on first identified mount
  useEffect(() => {
    if (me && !needsWelcome) goalRef.current?.focus()
  }, [me, needsWelcome])

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <StatusBar
        me={me}
        run={activeRun}
        runs={runs}
        connected={connected}
        onSwitchUser={switchUser}
        onOpenPicker={() => setPickerOpen(true)}
        onAbortRun={abortActive}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {viewMode === "visual" ? (
          <VisualPane onAnswer={onAnswer} />
        ) : (
          <div
            style={{ display: "flex", flex: 1, minHeight: 0 }}
            onClickCapture={(e) => {
              const target = e.target as HTMLElement
              const inLog = target.closest("[data-pane='log']")
              setFocused(inLog ? "log" : "stream")
            }}
          >
            <StreamPane
              ref={streamRef}
              active={focused === "stream"}
              rows={transcript}
              streaming={streaming}
              goalPlaceholder={activeRun?.goal ?? null}
              activeRunId={activeRunId}
            />
            <div data-pane="log" style={{ display: "flex", flex: 1, minWidth: 0 }}>
              <LogPane
                ref={logRef}
                active={focused === "log"}
                events={events}
                activeRunId={activeRunId}
              />
            </div>
          </div>
        )}
      </div>

      {viewMode === "tui" && pendingInput ? (
        <div
          style={{
            borderTop: "1px solid var(--c-audit)",
            background: "rgba(253, 230, 138, 0.08)",
            padding: "8px 14px",
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            flexShrink: 0,
            fontSize: "var(--fs-sm)",
          }}
        >
          <span style={{ color: "var(--c-audit)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }}>
            agent asks:
          </span>
          <span style={{ color: "var(--fg)", flex: 1, whiteSpace: "pre-wrap" }}>{pendingInput.question}</span>
          {pendingInput.options && pendingInput.options.length > 0 ? (
            <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>
              options: {pendingInput.options.join(" / ")}
            </span>
          ) : null}
        </div>
      ) : null}

      <GoalInput
        ref={goalRef}
        busy={busy}
        pendingQuestion={pendingInput?.question ?? null}
        onSubmit={onSubmitGoal}
        getSuggestions={(text) => slashSuggestions(text, commandsRef.current)}
      />

      <HelpBar busy={busy} />

      {paletteOpen ? (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      ) : null}

      {pickerOpen ? (
        <RunPicker
          runs={runs}
          activeId={activeRunId}
          onSelect={openRun}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {needsWelcome ? (
        <Welcome
          onSubmit={async (n, u) => { await setIdentity(n, u); await refresh() }}
        />
      ) : null}

      {adminOpen ? (
        <AdminLogin
          onClose={() => setAdminOpen(false)}
          onSubmit={async (pw) => {
            const r = await fetch("/api/admin-login", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password: pw }),
            })
            if (!r.ok) {
              const body = await r.json().catch(() => ({})) as { error?: string }
              throw new Error(body.error ?? `HTTP ${r.status}`)
            }
            await refresh()
            setAdminOpen(false)
          }}
        />
      ) : null}

      {!introDone ? <WelcomeIntro onDone={() => setIntroDone(true)} /> : null}
    </div>
  )
}

function HelpBar({ busy }: { busy: boolean }) {
  const item = (k: string, label: string, dim = false) => (
    <span style={{ marginRight: 22, display: "inline-flex", alignItems: "center", opacity: dim ? 0.5 : 1 }}>
      <span style={{
        color: "var(--accent)",
        background: "var(--bg-soft)",
        padding: "3px 9px",
        borderRadius: 4,
        marginRight: 8,
        fontSize: "var(--fs-sm)",
        letterSpacing: "0.02em",
        fontFamily: "var(--font-mono)",
      }}>{k}</span>
      <span style={{ color: "var(--fg-dim)" }}>{label}</span>
    </span>
  )
  return (
    <footer
      style={{
        borderTop: "1px solid var(--divider)",
        padding: "6px 14px",
        fontSize: "var(--fs-sm)",
        color: "var(--fg-mute)",
        userSelect: "none",
        flexShrink: 0,
        background: "var(--bg)",
        display: "flex",
        flexWrap: "wrap",
        rowGap: 4,
      }}
    >
      {item("Ctrl+K", "menu")}
      {item("?", "help")}
      {item("Ctrl+.", "abort run", !busy)}
      {item("Enter", "submit")}
      {item("Esc", "unfocus")}
    </footer>
  )
}

// =============================================================================
// FILE: main.tsx
// =============================================================================

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./theme.css"

const root = createRoot(document.getElementById("root")!)
root.render(<StrictMode><App /></StrictMode>)

// =============================================================================
// FILE: theme.css
// =============================================================================

/*
/*
 * agent001 // term — design tokens & base resets.
 *
 * Palette sourced from the "TypeScript code-editor" reference shot:
 * deep cool-black surface, off-white text, and pastel syntax-highlight
 * accents (purple keywords, green strings, yellow functions, blue
 * types, pink/peach, amber warnings, red errors). Every category in
 * the ops log gets one of these so origins are scannable at a glance.
 */

:root {
  /* Surfaces */
  --bg:        #0c0c10;          /* primary canvas */
  --bg-soft:   #15151b;          /* hovered row, focused-pane title strip */
  --bg-input:  #18181f;          /* prompt + filter input */
  --bg-elev:   #1d1d24;          /* modal panels */

  /* Foreground */
  --fg:        #e4e4e7;          /* primary text — zinc-100 */
  --fg-dim:    #a1a1aa;          /* secondary, timestamps, hints — zinc-400 */
  --fg-mute:   #6b6b78;          /* tertiary, placeholders, divider glyphs — zinc-500-ish */
  --fg-bright: #fafafa;          /* one-frame "flash" / scramble settle target */

  /* Accent — purple keyword from the screenshot */
  --accent:        #d8b4fe;      /* violet-300 — primary lavender */
  --accent-dim:    #a78bfa;      /* violet-400 — sub-accent (progress fill, mosaic) */
  --accent-soft:   rgba(216, 180, 254, 0.16);
  --accent-faint:  rgba(216, 180, 254, 0.06);

  /* Dividers */
  --divider:        rgba(255, 255, 255, 0.07);
  --divider-strong: rgba(255, 255, 255, 0.16);

  /* Pastel category colors for log lines (one per origin) */
  --c-llm:    #d8b4fe;           /* model / agent thinking — purple */
  --c-tool:   #86efac;           /* tool calls + results — green */
  --c-audit:  #fde68a;           /* user / audit / identity — yellow */
  --c-sync:   #f9a8d4;           /* sync, broadcasts — pink */
  --c-run:    #93c5fd;           /* run lifecycle — blue */
  --c-step:   #a5b4fc;           /* step events — indigo-300 */
  --c-debug:  #71717a;           /* debug.trace / verbose — zinc-500 */

  /* Semantic */
  --c-error:  #f87171;           /* red-400 */
  --c-ok:     #86efac;           /* green-300 */
  --c-warn:   #fbbf24;           /* amber-400 */

  /* Type — bumped one notch up so it doesn't squint */
  --font-mono: "JetBrains Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Menlo", monospace;
  --fs-base: 14px;
  --fs-sm:   13px;
  --fs-xs:   12px;
  --lh:      1.55;
}

* {
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  font-weight: 400;
  line-height: var(--lh);
  letter-spacing: 0.01em;
  overflow: hidden;
}

::selection {
  background: var(--accent-soft);
  color: var(--fg);
}

input, textarea, button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  outline: 0;
  padding: 0;
  margin: 0;
}
input::placeholder, textarea::placeholder { color: var(--fg-mute); }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.18); }

:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}

@keyframes a001-caret {
  0%, 49%   { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.t-caret {
  display: inline-block;
  width: 0.55em;
  height: 1em;
  vertical-align: -0.15em;
  background: var(--accent);
  animation: a001-caret 1s step-end infinite;
}

@keyframes a001-spin {
  0%   { content: "|"; }
  25%  { content: "/"; }
  50%  { content: "-"; }
  75%  { content: "\\"; }
  100% { content: "|"; }
}
.t-spin::before {
  content: "|";
  animation: a001-spin 0.8s steps(1, end) infinite;
}
*/
