/**
 * Global state store — zustand.
 *
 * Single source of truth for the entire dashboard:
 * views, widgets, runs, logs, audit, connection status.
 */

import { presentToolCall, serializeToolCallArgs } from "@mia/shared-types"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { api } from "./api"
import { BottomTab, EditorTab, RunStatus, SidebarSection } from "./enums"
import type {
  AuditEntry,
  BusMessage,
  LayoutItem,
  LogEntry,
  Notification,
  Run,
  RunDetail,
  SseEvent,
  Step,
  Thread,
  TraceEntry,
  ViewConfig,
  Widget,
  WidgetType,
} from "./types"
import { randomId } from "./util"

function patchRunFields(runs: Run[], runId: string, patch: Partial<Run>): Run[] {
  const index = runs.findIndex((run) => run.id === runId)
  if (index < 0) return runs
  const next = [...runs]
  next[index] = { ...next[index], ...patch }
  return next
}

function appendRunTrace(runs: Run[], runId: string, entry: TraceEntry): Run[] {
  const index = runs.findIndex((run) => run.id === runId)
  if (index < 0) return runs
  const next = [...runs]
  const trace = next[index].trace ?? []
  next[index] = { ...next[index], trace: trace.concat(entry) }
  return next
}

function mapRunTrace(runs: Run[], runId: string, update: (trace: TraceEntry[]) => TraceEntry[]): Run[] {
  const index = runs.findIndex((run) => run.id === runId)
  if (index < 0) return runs
  const next = [...runs]
  next[index] = { ...next[index], trace: update(next[index].trace ?? []) }
  return next
}

function isTerminalInfrastructureError(message: string | null | undefined): boolean {
  if (!message) return false
  const text = message.trim().toLowerCase()
  return text === "run cancelled by user"
    || text.startsWith("device flow failed:")
    || text.startsWith("device flow initiation failed:")
    || text.startsWith("device flow timed out")
    || text.startsWith("copilot oauth token expired")
}

/**
 * Reconstruct Step rows from a trace stream.
 *
 * Schema v14 dropped the `runs.data` column, so the server no longer
 * persists step rows directly — they live only as `tool-call` /
 * `tool-result` / `tool-error` entries inside `trace_entries`. Several
 * widgets (StepTimeline, ToolTimelinePanel, OperatorEnvironment's
 * "current activity" derivation, etc.) still consume `Step[]`, so we
 * rebuild the shape here from whatever trace the server returns.
 *
 * Pairing rule: tool-result / tool-error are matched to the most recent
 * un-terminated tool-call sharing the same `invocationId` (or by FIFO if
 * the entry has no invocationId, which can happen for legacy traces).
 */
function tracesToSteps(trace: TraceEntry[]): Step[] {
  const steps: Step[] = []
  const byInvocation = new Map<string, Step>()
  let order = 0
  for (const e of trace) {
    if (e.kind === "tool-call") {
      let input: Record<string, unknown> = {}
      try { input = e.argsFormatted ? JSON.parse(e.argsFormatted) as Record<string, unknown> : {} }
      catch { input = {} }
      const step: Step = {
        id: e.invocationId,
        name: e.tool,
        action: e.tool,
        status: RunStatus.Running,
        order: order++,
        input,
        output: {},
        error: null,
        startedAt: null,
        completedAt: null,
      }
      steps.push(step)
      byInvocation.set(e.invocationId, step)
    } else if (e.kind === "tool-result") {
      const target = e.invocationId ? byInvocation.get(e.invocationId) : steps.slice().reverse().find((s) => s.status === RunStatus.Running)
      if (target) {
        target.status = RunStatus.Completed
        target.output = { result: e.text }
      }
    } else if (e.kind === "tool-error") {
      const target = e.invocationId ? byInvocation.get(e.invocationId) : steps.slice().reverse().find((s) => s.status === RunStatus.Running)
      if (target) {
        target.status = RunStatus.Failed
        target.error = e.text
      }
    }
  }
  return steps
}

// ── Store shape ──────────────────────────────────────────────────

interface AppState {
  // Connection
  connected: boolean
  setConnected: (v: boolean) => void

  // Views (tabs)
  views: ViewConfig[]
  activeViewId: string
  setActiveView: (id: string) => void
  addView: (name: string) => string
  removeView: (id: string) => void
  renameView: (id: string, name: string) => void

  // Widgets
  addWidget: (viewId: string, type: WidgetType) => void
  removeWidget: (viewId: string, widgetId: string) => void
  updateLayouts: (viewId: string, layouts: LayoutItem[]) => void

  // Agent selection
  selectedAgentId: string | null
  setSelectedAgent: (id: string | null) => void

  // Runs
  runs: Run[]
  activeRunId: string | null
  setRuns: (runs: Run[]) => void
  setActiveRun: (id: string | null) => void
  upsertRun: (run: Partial<Run> & { id: string }) => void

  // Threads (home chat workspaces)
  threads: Thread[]
  activeThreadId: string | null
  threadSidebarCollapsed: boolean
  setThreads: (threads: Thread[]) => void
  upsertThread: (thread: Thread) => void
  setActiveThreadId: (id: string | null) => void
  setThreadSidebarCollapsed: (collapsed: boolean) => void
  selectThread: (id: string | null) => Promise<void>
  createNewThread: () => Promise<string>
  /** Widget continuity thread — set from whoami after login; server-provisioned. */
  workspaceThreadId: string | null
  setWorkspaceThreadId: (id: string | null) => void

  // Steps (for active run)
  steps: Step[]
  setSteps: (steps: Step[]) => void
  upsertStep: (step: Partial<Step> & { id: string }) => void

  // Logs (for active run)
  logs: LogEntry[]
  addLog: (log: LogEntry) => void
  setLogs: (logs: LogEntry[]) => void
  /**
   * Merge already-formatted LogEntry objects into the live `logs` array,
   * deduped by `(timestamp|type|message)` and re-sorted ascending. Used
   * when hydrating per-run logs from `/api/runs/:id` so we don't clobber
   * other entries (sync events, system events, other runs) that LiveLogs
   * is showing.
   */
  mergeLogs: (entries: LogEntry[]) => void
  hydrateLogsFromEvents: (events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }>) => void

  // Audit (for active run)
  audit: AuditEntry[]
  addAudit: (entry: AuditEntry) => void
  setAudit: (entries: AuditEntry[]) => void

  // Inter-agent bus messages (active run only). Mirrors AgentBusMessage
  // SSE — every message published anywhere in the run tree appears here
  // chronologically. `helpUnread` is the count of Help-protocol messages
  // that arrived since the user last opened the BusFeed; cleared by
  // ackBusHelp().
  busMessages: BusMessage[]
  helpUnread: number
  addBusMessage: (msg: BusMessage) => void
  setBusMessages: (msgs: BusMessage[]) => void
  ackBusHelp: () => void

  // Live usage for current run (updated via WS)
  liveUsage: { promptTokens: number; completionTokens: number; totalTokens: number; llmCalls: number }
  resetLiveUsage: () => void

  // Trace (rich agent execution log)
  trace: TraceEntry[]
  addTrace: (entry: TraceEntry) => void
  setTrace: (entries: TraceEntry[]) => void

  // Notifications
  notifications: Notification[]
  unreadCount: number
  setNotifications: (notifications: Notification[]) => void
  addNotification: (notification: Notification) => void
  markNotificationRead: (id: string) => void
  markAllRead: () => void

  // Modal widget viewer
  modalWidget: { type: WidgetType; runId?: string } | null
  openModalWidget: (type: WidgetType, runId?: string) => void
  closeModalWidget: () => void

  // Pending user input (ask_user tool)
  pendingInput: { runId: string; question: string; options?: string[]; sensitive?: boolean } | null
  clearPendingInput: () => void

  // Dismissed workspace diff run IDs (session-only — not persisted)
  dismissedWorkspaceDiffRunIds: Set<string>
  dismissWorkspaceDiff: (runId: string) => void

  // Tool calls that are currently executing and can be killed
  executingToolCalls: Map<string, { runId: string; toolCallId: string; toolName: string }>
  pendingKill: { runId: string; toolCallId: string; toolName: string } | null
  setPendingKill: (info: { runId: string; toolCallId: string; toolName: string } | null) => void

  // Raw SSE event log (platform dev)
  sseEventLog: SseEvent[]
  clearSseEventLog: () => void

  // Live streaming answer (chunks from LLM before run.completed)
  streamingAnswer: string
  appendStreamingChunk: (chunk: string) => void
  clearStreamingAnswer: () => void

  // Coherent generation live token stream (shown while LLM writes the bundle)
  coherentStream: string
  clearCoherentStream: () => void

  // IOE layout persistence (survives view switches + page reload)
  ioeLayout: IoeLayout
  setIoeLayout: (patch: Partial<IoeLayout>) => void

  // EnvSync widget form state (survives view switches + page reload)
  envSyncForm: EnvSyncFormState
  setEnvSyncForm: (patch: Partial<EnvSyncFormState>) => void

  // Last sync execute result from agent (chat-triggered). Cleared when widget resets.
  agentSyncExec: { planId: string; success: boolean; result: string } | null
  clearAgentSyncExec: () => void
  /** planId of an in-progress agent-triggered execute. Set on execute.started, cleared on execute.completed/failed. */
  agentSyncExecStarted: string | null

  // SSE event handler
  handleEvent: (event: SseEvent) => void
}

/** Persisted IOE panel layout. */
export interface IoeLayout {
  sidebarSection: SidebarSection
  sidebarVisible: boolean
  sidebarSplit: boolean
  sidebarBottomSection: SidebarSection
  sidebarSplitRatio: number
  bottomVisible: boolean
  chatVisible: boolean
  editorTab: EditorTab
  editorSplit: boolean
  editorRightTab: EditorTab
  bottomTab: BottomTab
  bottomSplit: boolean
  bottomRightTab: BottomTab
  sidebarWidth: number
  bottomHeight: number
  chatWidth: number
}

const DEFAULT_IOE_LAYOUT: IoeLayout = {
  sidebarSection: SidebarSection.Details,
  sidebarVisible: true,
  sidebarSplit: false,
  sidebarBottomSection: SidebarSection.Runs,
  sidebarSplitRatio: 0.5,
  bottomVisible: true,
  chatVisible: true,
  editorTab: EditorTab.ToolTimeline,
  editorSplit: false,
  editorRightTab: EditorTab.LlmCalls,
  bottomTab: BottomTab.Output,
  bottomSplit: false,
  bottomRightTab: BottomTab.Audit,
  sidebarWidth: 260,
  bottomHeight: 200,
  chatWidth: 300,
}

/** Persisted EnvSync widget form state. */
export interface EnvSyncFormState {
  source: string
  target: string
  entityType: string
  entityId: string
  force: boolean
  enabledOptionalTables: string[] | null
  /** Whether to search by 'id' or 'name'. */
  searchMode: "id" | "name"
  /** Last successfully-built plan id; widget re-hydrates plan via /api/sync/plan/:id on mount. */
  planId: string | null
}

const DEFAULT_ENV_SYNC_FORM: EnvSyncFormState = {
  source: "",
  target: "",
  entityType: "contract",
  entityId: "",
  force: false,
  enabledOptionalTables: null,
  searchMode: "id",
  planId: null,
}

// ── Default view ─────────────────────────────────────────────────

const DEFAULT_VIEW_ID = "default"

/**
 * Default view seed.
 *
 * Surgical change for login-flow → app continuity: a single full-canvas
 * term-chat widget is pre-seeded so the app's first paint after login
 * shows the same chat surface the login screen morphed into.
 *
 * Revert: replace `widgets`/`layouts` with `[]`/`{}` to restore the
 * original empty-canvas default. Existing users with saved layouts
 * are unaffected — only fresh users hit this seed.
 */
function makeDefaultView(): ViewConfig {
  const widgetId = "default-term-chat"
  return {
    id: DEFAULT_VIEW_ID,
    name: "Main",
    widgets: [{ id: widgetId, type: "term-chat" }],
    layouts: {
      lg: [{ i: widgetId, x: 0, y: 0, w: 12, h: 12, minW: 2, minH: 2 }],
    },
  }
}

// ── Widget default sizes ─────────────────────────────────────────

export const WIDGET_DEFAULTS: Record<WidgetType, { w: number, h: number, minW: number, minH: number }> = {
  "agent-chat":    { w: 4, h: 8,  minW: 2, minH: 2 },
  "term-chat":     { w: 4, h: 8,  minW: 2, minH: 2 },
  "run-status":    { w: 4, h: 4,  minW: 2, minH: 2 },
  "agent-viz":     { w: 6, h: 8,  minW: 2, minH: 2 },
  "live-logs":     { w: 6, h: 8,  minW: 4, minH: 2 },
  "audit-trail":   { w: 6, h: 8,  minW: 2, minH: 2 },
  "step-timeline": { w: 4, h: 10, minW: 2, minH: 2 },
  "tool-stats":    { w: 4, h: 6,  minW: 2, minH: 2 },
  "run-history":   { w: 4, h: 8,  minW: 2, minH: 2 },
  "operator-env": { w: 12, h: 10, minW: 2, minH: 2 },
  "debug-inspector": { w: 6, h: 10, minW: 2, minH: 2 },
  "mymi-db": { w: 12, h: 12, minW: 2, minH: 2 },
  "active-users": { w: 10, h: 10, minW: 2, minH: 2 },
  "env-sync": { w: 12, h: 14, minW: 4, minH: 4 },
  "operation-log": { w: 8, h: 12, minW: 4, minH: 4 },
  "entity-registry": { w: 12, h: 14, minW: 6, minH: 6 },
  "scd2-strategies": { w: 12, h: 14, minW: 6, minH: 6 },
  "freeze-windows":  { w: 10, h: 12, minW: 4, minH: 4 },
  "sync-proposals": { w: 12, h: 14, minW: 6, minH: 6 },
  "sync-approvals": { w: 10, h: 12, minW: 6, minH: 6 },
  "sync-evidence":  { w: 12, h: 12, minW: 6, minH: 6 },
  "sync-admin":     { w: 12, h: 14, minW: 6, minH: 6 },
}

const GRID_COLS = 12

/**
 * Find the best position for a new widget by locating the largest empty
 * rectangle in the current layout and sizing the widget to fill it.
 * If no gap exists, appends at the bottom with full width.
 */
function findBestFit(
  existingLayouts: LayoutItem[],
  widgetId: string,
  defaults: { w: number; h: number; minW: number; minH: number },
): LayoutItem {
  const { minW, minH } = defaults

  // First widget: full width
  if (existingLayouts.length === 0) {
    return { i: widgetId, x: 0, y: 0, w: GRID_COLS, h: defaults.h, minW, minH }
  }

  const maxY = Math.max(...existingLayouts.map((l) => l.y + l.h))

  // Build occupancy grid
  const grid: boolean[][] = Array.from({ length: maxY }, () => Array(GRID_COLS).fill(false))
  for (const l of existingLayouts) {
    for (let y = l.y; y < Math.min(l.y + l.h, maxY); y++) {
      for (let x = l.x; x < Math.min(l.x + l.w, GRID_COLS); x++) {
        grid[y][x] = true
      }
    }
  }

  // Find the largest empty rectangle within existing bounds
  let bestArea = 0
  let best = { x: 0, y: maxY, w: GRID_COLS, h: defaults.h }

  for (let sy = 0; sy < maxY; sy++) {
    for (let sx = 0; sx < GRID_COLS; sx++) {
      if (grid[sy][sx]) continue
      let maxW = GRID_COLS - sx
      for (let ey = sy; ey < maxY; ey++) {
        for (let ex = sx; ex < sx + maxW; ex++) {
          if (grid[ey][ex]) { maxW = ex - sx; break }
        }
        if (maxW < minW) break
        const h = ey - sy + 1
        if (h < minH) continue
        const area = maxW * h
        if (area > bestArea) { bestArea = area; best = { x: sx, y: sy, w: maxW, h } }
      }
    }
  }

  return { i: widgetId, x: best.x, y: best.y, w: best.w, h: best.h, minW, minH }
}

// ── Trace batching buffer ────────────────────────────────────────
const traceBuf: TraceEntry[] = []
let traceFlushScheduled = false

// Per-run trace batching (microtask) — coalesces a burst of trace events
// into a single store update so React rerenders once per tick instead of
// once per event. Critical when many tools/delegations run concurrently.
const runTraceBuf: Array<{ runId: string; entry: TraceEntry }> = []
const runCoherentBuf = new Map<string, string>()
const runAnswerBuf = new Map<string, string>()
let runFlushScheduled = false
// Answer chunks flush on requestAnimationFrame instead of microtask so the
// user perceives word-by-word streaming. SSE delivers many events in one
// network packet (EventSource dispatches them synchronously) — a microtask
// would collapse the entire burst into a single render. rAF caps to ~60fps
// which is the visual streaming cadence we want.
let answerFlushScheduled = false

function appendRunTraceMany(runs: Run[], runId: string, entries: TraceEntry[]): Run[] {
  if (entries.length === 0) return runs
  const index = runs.findIndex((run) => run.id === runId)
  if (index < 0) return runs
  const next = [...runs]
  const trace = next[index].trace ?? []
  next[index] = { ...next[index], trace: trace.concat(entries) }
  return next
}

function scheduleRunFlush(set: (fn: (s: AppState) => Partial<AppState>) => void) {
  if (runFlushScheduled) return
  runFlushScheduled = true
  queueMicrotask(() => {
    runFlushScheduled = false
    const traceBatch = runTraceBuf.splice(0)
    const tokenBatch = new Map(runCoherentBuf)
    runCoherentBuf.clear()
    if (traceBatch.length === 0 && tokenBatch.size === 0) return
    set((s) => {
      let runs = s.runs
      if (traceBatch.length > 0) {
        const grouped = new Map<string, TraceEntry[]>()
        for (const { runId, entry } of traceBatch) {
          const arr = grouped.get(runId) ?? []
          arr.push(entry)
          grouped.set(runId, arr)
        }
        for (const [runId, entries] of grouped) {
          runs = appendRunTraceMany(runs, runId, entries)
        }
      }
      if (tokenBatch.size > 0) {
        for (const [runId, addition] of tokenBatch) {
          const idx = runs.findIndex((r) => r.id === runId)
          if (idx < 0) continue
          const cur = runs[idx].coherentStream ?? ""
          const merged = cur + addition
          if (runs === s.runs) runs = [...runs]
          runs[idx] = { ...runs[idx], coherentStream: merged }
        }
      }
      return { runs }
    })
  })
}

function scheduleAnswerFlush(set: (fn: (s: AppState) => Partial<AppState>) => void) {
  if (answerFlushScheduled) return
  answerFlushScheduled = true
  const flush = () => {
    answerFlushScheduled = false
    const batch = new Map(runAnswerBuf)
    runAnswerBuf.clear()
    if (batch.size === 0) return
    set((s) => {
      let runs = s.runs
      for (const [runId, addition] of batch) {
        const idx = runs.findIndex((r) => r.id === runId)
        if (idx < 0) continue
        const cur = runs[idx].streamingAnswer ?? ""
        const merged = cur + addition
        if (runs === s.runs) runs = [...runs]
        runs[idx] = { ...runs[idx], streamingAnswer: merged }
      }
      return { runs }
    })
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush)
  } else {
    setTimeout(flush, 16)
  }
}

// ── Event → human-readable log entry with type + error flag ─────

/**
 * Derive the event type group from the raw SSE event name.
 * Used as the primary filter dimension in the Event Stream widget.
 */
function eventType(type: string): string {
  if (type.startsWith("sync.")) return "sync"
  if (type.startsWith("run.")) return "run"
  if (type.startsWith("step.")) return "step"
  if (type.startsWith("tool_call.")) return "step"
  if (type.startsWith("delegation.")) return "agent"
  if (type.startsWith("planner.")) return "agent"
  if (type === "debug.trace") return "agent"
  if (type === "agent.thinking") return "agent"
  if (type === "agent.bus.message") return "agent"
  if (type === "agent.help.requested") return "agent"
  if (type === "answer.chunk") return "agent"
  if (type === "api.request") return "api"
  return "system"
}

/**
 * Build a LogEntry with the correct type, error flag, and a clean
 * human-readable message for every known event. Returns null for
 * high-frequency events that would spam the log (answer.chunk, debug.trace).
 */
function formatLogEntry(
  type: string,
  data: Record<string, unknown>,
  timestamp: string,
): LogEntry | null {
  const entry = formatLogEntryInner(type, data, timestamp)
  if (entry) {
    entry.eventName = type
    entry.data = data
  }
  return entry
}

function formatLogEntryInner(
  type: string,
  data: Record<string, unknown>,
  timestamp: string,
): LogEntry | null {
  const t = eventType(type)

  if (type === "debug.trace") {
    const entry = data["entry"] as Record<string, unknown> | undefined
    if ((entry?.["kind"] as string | undefined) === "planner-sql-quality") {
      const validationCode = typeof entry["validationCode"] === "string" ? entry["validationCode"] : null
      const missingMirrors = Array.isArray(entry["missingPersistedMirrorCandidates"])
        ? (entry["missingPersistedMirrorCandidates"] as string[])
        : []
      const tempScalarSubqueryCount = Number(entry["tempScalarSubqueryCount"] ?? 0)
      const largeObjectRefs = Array.isArray(entry["largeObjectRefs"])
        ? (entry["largeObjectRefs"] as Array<{ name?: string; count?: number }>).filter((ref) => Number(ref.count ?? 0) > 2)
        : []
      const notes: string[] = []
      if (validationCode) notes.push(`blocked=${validationCode}`)
      if (missingMirrors.length > 0) notes.push(`mirror=${missingMirrors.join(",")}`)
      if (largeObjectRefs.length > 0) notes.push(largeObjectRefs.map((ref) => `${ref.name ?? "object"}×${Number(ref.count ?? 0)}`).join(", "))
      if (tempScalarSubqueryCount > 0) notes.push(`temp-subq=${tempScalarSubqueryCount}`)
      return {
        type: t,
        message: `SQL quality — ${String(entry["phase"] ?? "checked")}${notes.length ? ` · ${notes.join(" · ")}` : " · ok"}`,
        timestamp,
        error: validationCode != null || entry["phase"] === "blocked",
      }
    }
    if ((entry?.["kind"] as string | undefined) === "planner-prompt-budget") {
      const before = Number(entry["totalBeforeChars"] ?? 0)
      const after = Number(entry["totalAfterChars"] ?? 0)
      const dropped = Array.isArray(entry["droppedSections"]) ? (entry["droppedSections"] as string[]) : []
      const parts = [`${before.toLocaleString()} → ${after.toLocaleString()} chars`]
      if (dropped.length > 0) parts.push(`dropped=${dropped.join(",")}`)
      return {
        type: t,
        message: `Prompt budget · ${parts.join(" · ")}`,
        timestamp,
        error: false,
      }
    }
    return null
  }

  // ── Sync events ─────────────────────────────────────────────
  if (type.startsWith("sync.")) {
    const planId = (data["planId"] as string | undefined)?.slice(0, 8) ?? ""
    switch (type) {
      case "sync.preview.started":
        return { type: t, message: `Preview started — ${data["entityType"]}#${data["entityId"]} (${data["source"]} → ${data["target"]})`, timestamp }
      case "sync.preview.completed":
        return { type: t, message: `Preview complete — plan ${planId}`, timestamp }
      case "sync.preview.failed":
        return { type: t, error: true, message: `Preview failed: ${data["error"] ?? "unknown"}`, timestamp }
      case "sync.preview.sql": {
        const rows = data["rowCount"] != null ? `${data["rowCount"]} rows` : "?"
        const dur = data["durationMs"] != null ? `${data["durationMs"]}ms` : ""
        return { type: t, message: `SQL preview — ${data["label"] ?? "?"}  →  ${rows}${dur ? ` in ${dur}` : ""}`, timestamp }
      }
      case "sync.preview.table.start":
        return { type: t, message: `Scanning ${data["table"]}…`, timestamp }
      case "sync.preview.table.done":
        return { type: t, message: `${data["table"]} — ${data["insert"] ?? 0} ins, ${data["update"] ?? 0} upd, ${data["delete"] ?? 0} del`, timestamp }
      case "sync.preview.table.failed":
        return { type: t, error: true, message: `${data["table"]} — failed: ${data["error"] ?? "unknown"}`, timestamp }
      case "sync.execute.started":
        return { type: t, message: `Execute started — plan ${planId} (${data["source"]} → ${data["target"]})`, timestamp }
      case "sync.execute.step":
        return { type: t, message: `${data["step"]}`, timestamp }
      case "sync.execute.step.failed":
        return {
          type: t,
          error: true,
          message: [
            data["step"],
            data["op"],
            data["table"],
          ].filter(Boolean).join(" · ") + ` failed — ${data["cause"] ?? data["error"] ?? "unknown"}`,
          timestamp,
        }
      case "sync.execute.table.start":
        return { type: t, message: `${data["table"]} — ${data["op"]} ${data["rowsTotal"]} rows…`, timestamp }
      case "sync.execute.table.done":
        return { type: t, message: `${data["table"]} — ${data["rowsApplied"]} rows applied`, timestamp }
      case "sync.execute.completed": {
        const dur = data["durationMs"] as number | undefined
        const durStr = dur != null ? ` in ${(dur / 1000).toFixed(1)}s` : ""
        const warns = data["warnings"] as Array<{ step: string; error: string }> | undefined
        const warnStr = warns && warns.length > 0 ? ` (${warns.length} warning${warns.length === 1 ? "" : "s"})` : ""
        return { type: t, error: !!(warns && warns.length > 0), message: `Execute complete — plan ${planId}${durStr}${warnStr}`, timestamp }
      }
      case "sync.execute.failed":
        return {
          type: t,
          error: true,
          message: `Execute failed — plan ${planId}: ${[
            data["step"],
            data["op"],
            data["table"],
          ].filter(Boolean).join(" · ") || "execute"} — ${data["cause"] ?? data["error"] ?? "unknown"}`,
          timestamp,
        }
      case "sync.execute.drift.revalidated": {
        const pct = data["maxDriftPct"] as number | undefined
        return { type: t, message: `Drift re-validated — max ${((pct ?? 0) * 100).toFixed(1)}%`, timestamp }
      }
      case "sync.execute.archive.skipped":
        return { type: t, message: `Archive skipped — ${data["reason"] ?? ""}`, timestamp }
      case "sync.execute.sql": {
        const dur = data["durationMs"] as number | undefined
        const label = data["label"] as string | undefined
        return { type: t, message: `SQL ${label ?? "query"} — ${data["rowCount"] ?? "?"} rows, ${dur ?? "?"}ms`, timestamp }
      }
      default:
        return { type: t, message: type.slice(5), timestamp }
    }
  }

  // ── All other events ────────────────────────────────────────
  switch (type) {
    // Run lifecycle
    case "run.queued":
      return { type: t, message: `Queued — ${((data["goal"] as string) ?? "").slice(0, 120)}`, timestamp }
    case "run.started":
      return { type: t, message: `Started — run ${(data["runId"] as string)?.slice(0, 8)}`, timestamp }
    case "run.completed":
      return { type: t, message: `Completed — ${data["stepCount"] ?? "?"} steps`, timestamp }
    case "run.failed":
      return { type: t, error: true, message: `Failed — ${((data["error"] as string) ?? "unknown").slice(0, 200)}`, timestamp }
    case "run.cancelled":
      return { type: t, error: true, message: `Cancelled`, timestamp }

    // Steps
    case "step.started":
      return { type: t, message: `${(data["action"] as string) ?? "unknown"} started`, timestamp }
    case "step.completed":
      return { type: t, message: `${(data["action"] as string) ?? "unknown"} completed`, timestamp }
    case "step.failed":
      return { type: t, error: true, message: `${(data["action"] as string) ?? "unknown"} failed — ${((data["error"] as string) ?? "unknown").slice(0, 200)}`, timestamp }

    // Tool calls
    case "tool_call.executing":
      return { type: t, message: `Executing ${data["toolName"]}`, timestamp }
    case "tool_call.completed":
      return { type: t, message: `${data["toolName"] ?? "tool"} done`, timestamp }
    case "tool_call.killed":
      return { type: t, error: true, message: `${data["toolName"] ?? "tool"} killed`, timestamp }

    // Delegation
    case "delegation.started":
      return { type: t, message: `Delegated — ${((data["goal"] as string) ?? "").slice(0, 120)}`, timestamp }
    case "delegation.ended":
      return { type: t, error: data["status"] === "error" || undefined, message: `Delegation ${data["status"]}`, timestamp }
    case "delegation.iteration":
      return { type: t, message: `Iteration ${data["iteration"]}/${data["maxIterations"]}`, timestamp }
    case "delegation.parallel-started":
      return { type: t, message: `Parallel — ${data["taskCount"]} tasks`, timestamp }
    case "delegation.parallel-ended":
      return { type: t, message: `Parallel done — ${data["fulfilled"]} ok, ${data["rejected"]} failed`, timestamp }

    // Planner
    case "planner.started":
      return { type: t, message: `Planning started`, timestamp }
    case "planner.completed":
      return { type: t, message: `Planning completed — ${data["completedSteps"] ?? "?"}/${data["totalSteps"] ?? "?"} steps`, timestamp }
    case "planner.validation.failed":
      return { type: t, error: true, message: `Validation failed`, timestamp }
    case "planner.validation.remediated":
      return { type: t, message: `Validation remediated`, timestamp }
    case "planner.pipeline.started":
      return { type: t, message: `Pipeline attempt ${data["attempt"]}/${data["maxRetries"]}`, timestamp }
    case "planner.coherent.bootstrap":
      return { type: t, message: `Coherent bootstrap — ${data["artifactCount"]} artifacts`, timestamp }
    case "planner.architecture.state":
      return { type: t, message: `Architecture ${data["lane"]} — ${data["status"]}`, timestamp }

    // Thinking
    case "agent.thinking":
      return { type: t, message: (data["content"] as string) ?? "", timestamp }
    case "agent.bus.message": {
      const from = (data["fromAgent"] as string) ?? "?"
      const proto = (data["protocol"] as string) ?? "broadcast"
      const topic = (data["topic"] as string) ?? "?"
      const content = ((data["content"] as string) ?? "").slice(0, 120)
      return { type: t, message: `[bus ${proto}] ${from} → ${topic}: ${content}`, timestamp }
    }
    case "agent.help.requested": {
      const from = (data["fromAgent"] as string) ?? "?"
      const content = ((data["content"] as string) ?? "").slice(0, 120)
      return { type: t, error: true, message: `[HELP] ${from}: ${content}`, timestamp }
    }
    case "answer.chunk":
      return null

    // API
    case "api.request": {
      const method = data["method"] as string | undefined
      const url = data["url"] as string | undefined
      const status = data["status_code"] as number | undefined
      const dur = data["duration_ms"] as number | undefined
      const isErr = status != null && status >= 400
      return { type: t, error: isErr || undefined, message: `${method ?? "?"} ${url ?? "?"} → ${status ?? "?"} (${dur ?? "?"}ms)`, timestamp }
    }

    // System / notifications / memory / usage / misc
    case "audit":
      return { type: t, message: `${data["action"]} by ${data["actor"]}`, timestamp }
    case "notification":
      return { type: t, message: `${data["title"]}`, timestamp }
    case "user_input.required":
      return { type: t, message: `Waiting for input — ${((data["question"] as string) ?? "").slice(0, 120)}`, timestamp }
    case "user_input.response":
      return { type: t, message: `Input received`, timestamp }
    case "usage.updated":
      return { type: t, message: `${data["totalTokens"]} tokens, ${data["llmCalls"]} calls`, timestamp }
    case "procedural.stored":
      return { type: t, message: `Procedural memory stored — ${data["trigger"]}`, timestamp }
    case "message.queued":
      return { type: t, message: `Message queued — ${data["channelType"]}`, timestamp }
    case "message.failed":
      return { type: t, error: true, message: `Message failed — ${data["error"] ?? "unknown"}`, timestamp }
    case "checkpoint.saved":
      return { type: t, message: `Checkpoint saved — iteration ${data["iteration"]}`, timestamp }
    case "rollback.started":
      return { type: t, message: `Rollback started — ${data["effectCount"]} effects`, timestamp }
    case "rollback.effect":
      return { type: t, message: `Rollback ${data["action"]} — ${data["target"]}`, timestamp }
    case "approval.required":
      return { type: t, message: `Approval required — ${data["toolName"]}: ${data["reason"]}`, timestamp }
    case "events.connected":
      return { type: t, message: `Connected to event stream`, timestamp }
    case "events.disconnected":
      return { type: t, error: true, message: `Disconnected from event stream`, timestamp }
    case "debug.trace":
      return null // suppress — high volume internal traces

    default:
      return { type: t, message: type.replace(/^[^.]+\./, ""), timestamp }
  }
}

// ── Store ────────────────────────────────────────────────────────

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Connection
      connected: false,
      setConnected: (connected) => set({ connected }),

      // Views
      views: [makeDefaultView()],
      activeViewId: DEFAULT_VIEW_ID,
      setActiveView: (id) => set({ activeViewId: id }),
      addView: (name) => {
        const id = randomId()
        set((s) => ({
          views: [...s.views, { id, name, widgets: [], layouts: {} }],
          activeViewId: id,
        }))
        return id
      },
      removeView: (id) => set((s) => {
        const filtered = s.views.filter((v) => v.id !== id)
        if (filtered.length === 0) filtered.push(makeDefaultView())
        return {
          views: filtered,
          activeViewId: s.activeViewId === id ? filtered[0].id : s.activeViewId,
        }
      }),
      renameView: (id, name) => set((s) => ({
        views: s.views.map((v) => v.id === id ? { ...v, name } : v),
      })),

      // Widgets
      addWidget: (viewId, type) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        const widget: Widget = { id: randomId(), type }
        const newWidgets = [...view.widgets, widget]
        const existing = view.layouts["lg"] ?? []
        const defaults = WIDGET_DEFAULTS[type]
        const newItem = findBestFit(existing, widget.id, defaults)
        return {
          views: s.views.map((v) =>
            v.id === viewId
              ? { ...v, widgets: newWidgets, layouts: { ...v.layouts, lg: [...existing, newItem] } }
              : v,
          ),
        }
      }),
      removeWidget: (viewId, widgetId) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        const newWidgets = view.widgets.filter((w) => w.id !== widgetId)
        const newLayouts = (view.layouts["lg"] ?? []).filter((l) => l.i !== widgetId)
        return {
          views: s.views.map((v) =>
            v.id === viewId
              ? { ...v, widgets: newWidgets, layouts: { ...v.layouts, lg: newLayouts } }
              : v,
          ),
        }
      }),
      updateLayouts: (viewId, layouts) => set((s) => ({
        views: s.views.map((v) => {
          if (v.id !== viewId) return v
          // RGL's onLayoutChange fires for many reasons besides a real user
          // gesture: mount, child sync, breakpoint/width changes,
          // compaction. During its `synchronizeLayoutWithChildren` pass it
          // can briefly emit items at the default 1×1 size — smaller than
          // the widget's configured minW/minH. If we blindly accepted those
          // and clamped them to the minimum, we would permanently shrink
          // user-sized widgets to their floor on every restore. So: when an
          // incoming item is smaller than its widget's configured minimum,
          // treat it as a bookkeeping emission and KEEP the previously
          // stored w/h instead of overwriting. Real user resizes always
          // produce w ≥ minW (RGL enforces that on the resize handle) and
          // pass through unchanged. We still re-inject the current
          // minW/minH so layouts saved before this guard pick them up.
          const prevById = new Map(
            (v.layouts["lg"] ?? []).map((item) => [item.i, item]),
          )
          const normalized = layouts.map((item) => {
            const widget = v.widgets.find((w) => w.id === item.i)
            if (!widget) return item
            const defaults = WIDGET_DEFAULTS[widget.type]
            if (!defaults) return item
            const prev = prevById.get(item.i)
            const undersized =
              item.w < defaults.minW || item.h < defaults.minH
            return {
              ...item,
              minW: defaults.minW,
              minH: defaults.minH,
              w: undersized && prev ? prev.w : Math.max(item.w, defaults.minW),
              h: undersized && prev ? prev.h : Math.max(item.h, defaults.minH),
            }
          })
          return { ...v, layouts: { ...v.layouts, lg: normalized } }
        }),
      })),

      // Agent selection
      selectedAgentId: null,
      setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),

      // Runs
      runs: [],
      activeRunId: null,
      // Merge incoming run rows into the store WITHOUT clobbering live,
      // SSE-accumulated per-run fields. `api.listRuns()` returns the row
      // metadata only (id/goal/status/counts) — it never carries the live
      // `trace`, `streamingAnswer`, `coherentStream`, `stepData`, or
      // `auditTrail` that we accumulate from the event stream. A plain
      // `set({ runs })` would wipe all of that, which is exactly what
      // happened when widgets like RunHistory re-fetched the run list on
      // mount: switching to a view containing RunHistory and then back
      // to TermChat would erase the active run's narrative + tool calls.
      //
      // Also keep in-memory-only rows (in-flight runs, thread-scoped rows
      // not yet visible in the latest listRuns response) so switching from
      // chat home → platform widgets does not blank the conversation.
      setRuns: (runs) => set((s) => {
        const prevById = new Map(s.runs.map((r) => [r.id, r]))
        const incomingIds = new Set(runs.map((r) => r.id))
        const merged = runs.map((incoming) => {
          const existing = prevById.get(incoming.id)
          if (!existing) return incoming
          return {
            ...incoming,
            trace: existing.trace?.length ? existing.trace : (incoming.trace ?? existing.trace),
            streamingAnswer: existing.streamingAnswer ?? incoming.streamingAnswer,
            coherentStream: existing.coherentStream ?? incoming.coherentStream,
            stepData: existing.stepData?.length ? existing.stepData : incoming.stepData,
            auditTrail: existing.auditTrail?.length ? existing.auditTrail : incoming.auditTrail,
          }
        })
        const orphans = s.runs.filter((r) => !incomingIds.has(r.id))
        return { runs: orphans.length > 0 ? [...merged, ...orphans] : merged }
      }),
      setActiveRun: (activeRunId) => {
        set({ activeRunId })
        if (!activeRunId) return
        // Load historical run data into the store so all widgets reflect
        // the selected run (steps, trace, audit, logs).
        const store = get()
        const run = store.runs.find((r) => r.id === activeRunId)
        const isLive = run?.status === RunStatus.Pending || run?.status === RunStatus.Running || run?.status === RunStatus.Planning
        if (isLive) return  // live run already has fresh data in store
        Promise.all([
          api.getRun(activeRunId),
          api.getRunTrace(activeRunId),
        ]).then(([detail, rawTrace]) => {
          const d = detail as RunDetail
          const trace = rawTrace as TraceEntry[]
          // Schema v14: server no longer ships steps in d.data — derive
          // from the trace so all step-driven widgets (StepTimeline,
          // ToolTimelinePanel, problems, current-activity) keep working
          // for historical runs. If the server ever brings back d.data.steps,
          // we prefer that over the derived shape.
          const steps = d.data?.steps?.length ? d.data.steps : tracesToSteps(trace)
          get().setSteps(steps)
          get().setAudit(d.audit ?? [])
          if (d.logs?.length) get().mergeLogs(d.logs)
          get().setTrace(trace)
          set((s) => ({
            runs: patchRunFields(s.runs, activeRunId, {
              stepData: steps,
              auditTrail: d.audit ?? [],
              trace,
              streamingAnswer: "",
              coherentStream: "",
            }),
          }))
        }).catch(() => {})
      },
      upsertRun: (run) => set((s) => {
        const idx = s.runs.findIndex((r) => r.id === run.id)
        if (idx >= 0) {
          const current = s.runs[idx]
          const currentRecord = current as unknown as Record<string, unknown>
          let changed = false
          for (const [k, v] of Object.entries(run)) {
            if (currentRecord[k] !== v) {
              changed = true
              break
            }
          }
          if (!changed) return s
          const updated = [...s.runs]
          updated[idx] = { ...current, ...run }
          return { runs: updated }
        }
        // New run — insert it. Only auto-select if nothing is selected yet:
        // events for background runs (e.g. started by another widget while
        // the user is reading a different run) must NOT hijack the active
        // selection. This used to be the root cause of "I started a run in
        // termchat, switched to IOE, came back, and my run is gone" — a
        // sync.run started by IOE silently became the new active run.
        const appendToThread =
          s.activeThreadId && run.threadId === s.activeThreadId
        return {
          runs: appendToThread ? [...s.runs, run as Run] : [run as Run, ...s.runs],
          activeRunId: s.activeRunId ?? run.id,
        }
      }),

      threads: [],
      activeThreadId: null,
      threadSidebarCollapsed: false,
      setThreads: (threads) => set({ threads }),
      upsertThread: (thread) =>
        set((s) => {
          const index = s.threads.findIndex((t) => t.id === thread.id)
          if (index < 0) return { threads: [thread, ...s.threads] }
          const next = [...s.threads]
          next[index] = { ...next[index], ...thread }
          next.sort((a, b) => {
            if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
            return b.updatedAt.localeCompare(a.updatedAt)
          })
          return { threads: next }
        }),
      setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
      setThreadSidebarCollapsed: (threadSidebarCollapsed) => set({ threadSidebarCollapsed }),
      selectThread: async (threadId) => {
        set({
          activeThreadId: threadId,
          activeRunId: null,
          steps: [],
          trace: [],
          audit: [],
          pendingInput: null,
        })
        if (!threadId) {
          set({ runs: [] })
          return
        }
        try {
          const runs = await api.listThreadRuns(threadId)
          set({ runs })
          if (runs.length > 0) {
            get().setActiveRun(runs[runs.length - 1]!.id)
          }
        } catch {
          set({ runs: [] })
        }
      },
      createNewThread: async () => {
        const thread = await api.createThread()
        set((s) => ({ threads: [thread, ...s.threads] }))
        await get().selectThread(thread.id)
        return thread.id
      },
      workspaceThreadId: null,
      setWorkspaceThreadId: (workspaceThreadId) => set({ workspaceThreadId }),

      // Steps
      steps: [],
      setSteps: (steps) => set({ steps }),
      upsertStep: (step) => set((s) => {
        const idx = s.steps.findIndex((st) => st.id === step.id)
        if (idx >= 0) {
          const updated = [...s.steps]
          updated[idx] = { ...updated[idx], ...step }
          return { steps: updated }
        }
        return { steps: [...s.steps, step as Step] }
      }),

      // Logs — capped at 5000 entries to prevent unbounded growth
      logs: [],
      addLog: (log) => set((s) => ({ logs: [...s.logs, log].slice(-5000) })),
      setLogs: (logs) => set({ logs }),
      mergeLogs: (entries) => set((s) => {
        if (entries.length === 0) return {}
        const seen = new Set(s.logs.map((l) => `${l.timestamp}|${l.type}|${l.message}`))
        const merged = [...s.logs]
        for (const f of entries) {
          const key = `${f.timestamp}|${f.type}|${f.message}`
          if (!seen.has(key)) { merged.push(f); seen.add(key) }
        }
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        return { logs: merged.slice(-5000) }
      }),
      hydrateLogsFromEvents: (events) => set((s) => {
        const fresh: LogEntry[] = []
        for (const ev of events) {
          const entry = formatLogEntry(ev.type, ev.data ?? {}, ev.timestamp)
          if (entry) fresh.push(entry)
        }
        if (fresh.length === 0) return {}
        // Dedup against anything already in the live array — prevents
        // double-counting when an event arrived live AND is in the backfill.
        const seen = new Set(s.logs.map((l) => `${l.timestamp}|${l.type}|${l.message}`))
        const merged = [...s.logs]
        for (const f of fresh) {
          const key = `${f.timestamp}|${f.type}|${f.message}`
          if (!seen.has(key)) { merged.push(f); seen.add(key) }
        }
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        return { logs: merged.slice(-5000) }
      }),

      // Audit
      audit: [],
      addAudit: (entry) => set((s) => ({ audit: [...s.audit, entry] })),
      setAudit: (audit) => set({ audit }),

      busMessages: [],
      helpUnread: 0,
      addBusMessage: (msg) => set((s) => ({
        busMessages: [...s.busMessages, msg].slice(-500),
        helpUnread: msg.protocol === "help" ? s.helpUnread + 1 : s.helpUnread,
      })),
      setBusMessages: (msgs) => set({ busMessages: msgs.slice(-500) }),
      ackBusHelp: () => set({ helpUnread: 0 }),

      // Live usage
      liveUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 },
      resetLiveUsage: () => set({ liveUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, llmCalls: 0 } }),

      // Trace — batched via microtask to avoid per-entry re-renders
      trace: [],
      addTrace: (entry) => {
        const kind = (entry as Record<string, unknown>).kind as string | undefined
        // coherent-generation-token events are high-frequency (one per streamed token).
        // Accumulate them in coherentStream instead of flooding the trace array.
        if (kind === "coherent-generation-token") {
          const token = (entry as Record<string, unknown>).token as string ?? ""
          set((s) => ({ coherentStream: s.coherentStream + token }))
          return
        }
        // Clear coherent stream when generation completes or fails
        if (kind === "coherent-generation-bundle" || kind === "coherent-generation-failed") {
          set({ coherentStream: "" })
        }
        traceBuf.push(entry)
        if (!traceFlushScheduled) {
          traceFlushScheduled = true
          queueMicrotask(() => {
            const batch = traceBuf.splice(0)
            traceFlushScheduled = false
            if (batch.length > 0) {
              set((s) => ({ trace: s.trace.concat(batch) }))
            }
          })
        }
      },
      setTrace: (trace) => {
        // When setTrace is called, discard any pending buffered entries
        traceBuf.length = 0
        set({ trace })
      },

      // Notifications
      notifications: [],
      unreadCount: 0,
      setNotifications: (notifications) => set({
        notifications,
        unreadCount: notifications.filter((n) => !n.read).length,
      }),
      addNotification: (notification) => set((s) => ({
        notifications: [notification, ...s.notifications].slice(0, 100),
        unreadCount: s.unreadCount + (notification.read ? 0 : 1),
      })),
      markNotificationRead: (id) => set((s) => {
        const updated = s.notifications.map((n) =>
          n.id === id ? { ...n, read: true } : n,
        )
        return {
          notifications: updated,
          unreadCount: updated.filter((n) => !n.read).length,
        }
      }),
      markAllRead: () => set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
        unreadCount: 0,
      })),

      // Modal widget viewer
      modalWidget: null,
      openModalWidget: (type, runId) => set({ modalWidget: { type, runId } }),
      closeModalWidget: () => set({ modalWidget: null }),

      // Pending user input
      pendingInput: null,
      clearPendingInput: () => set({ pendingInput: null }),

      // Dismissed workspace diff run IDs (session-only)
      dismissedWorkspaceDiffRunIds: new Set<string>(),
      dismissWorkspaceDiff: (runId) => set((s) => ({
        dismissedWorkspaceDiffRunIds: new Set([...s.dismissedWorkspaceDiffRunIds, runId]),
      })),

      // Executing tool calls + kill
      executingToolCalls: new Map(),
      pendingKill: null,
      setPendingKill: (info) => set({ pendingKill: info }),

      // Raw WS event log
      sseEventLog: [],
      clearSseEventLog: () => set({ sseEventLog: [] }),

      streamingAnswer: "",
      appendStreamingChunk: (chunk) => set((s) => ({ streamingAnswer: s.streamingAnswer + chunk })),
      clearStreamingAnswer: () => set({ streamingAnswer: "" }),

      coherentStream: "",
      clearCoherentStream: () => set({ coherentStream: "" }),

      // IOE layout
      ioeLayout: { ...DEFAULT_IOE_LAYOUT },
      setIoeLayout: (patch) => set((s) => ({ ioeLayout: { ...s.ioeLayout, ...patch } })),

      envSyncForm: { ...DEFAULT_ENV_SYNC_FORM },
      setEnvSyncForm: (patch) => set((s) => ({ envSyncForm: { ...s.envSyncForm, ...patch } })),

      agentSyncExec: null,
      clearAgentSyncExec: () => set({ agentSyncExec: null }),
      agentSyncExecStarted: null,

      // SSE event handler
      handleEvent: (event) => {
        const { type, data, timestamp } = event
        const store = get()

        // Record raw event for PlatformDevLog
        set({ sseEventLog: [...store.sseEventLog, event].slice(-2000) })

        // ── Build a properly-levelled + categorised log entry ──
        const logEntry = formatLogEntry(type, data, timestamp)
        if (logEntry) store.addLog(logEntry)

        switch (type) {
          case "run.queued":
            // Clear previous run's live state so Live tab starts fresh
            store.setTrace([])
            store.setSteps([])
            store.setAudit([])
            store.setBusMessages([])
            set({ helpUnread: 0 })
            store.resetLiveUsage()
            store.clearStreamingAnswer()
            store.addTrace({ kind: "goal", text: data["goal"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              goal: data["goal"] as string,
              status: RunStatus.Pending,
              answer: null,
              stepCount: 0,
              error: null,
              pendingWorkspaceChanges: 0,
              parentRunId: (data["resumedFrom"] as string) ?? null,
              agentId: (data["agentId"] as string) ?? null,
              createdAt: timestamp,
              completedAt: null,
              totalTokens: 0,
              promptTokens: 0,
              completionTokens: 0,
              llmCalls: 0,
              trace: [],
              streamingAnswer: "",
              coherentStream: "",
              auditTrail: [],
              stepData: [],
              threadId: get().activeThreadId,
            })
            if (get().activeThreadId) {
              const threadId = get().activeThreadId!
              const existing = get().threads.find((t) => t.id === threadId)
              if (existing) {
                store.upsertThread({
                  ...existing,
                  updatedAt: timestamp,
                  runCount: (existing.runCount ?? 0) + 1,
                })
              }
            }
            break

          case "run.started":
            store.upsertRun({
              id: data["runId"] as string,
              status: RunStatus.Running,
            })
            break

          case "run.completed":
            store.clearStreamingAnswer()
            store.addTrace({ kind: "answer", text: data["answer"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              status: RunStatus.Completed,
              answer: data["answer"] as string,
              stepCount: data["stepCount"] as number,
              pendingWorkspaceChanges: (data["pendingWorkspaceChanges"] as number) ?? 0,
              completedAt: timestamp,
              totalTokens: (data["totalTokens"] as number) ?? 0,
              promptTokens: (data["promptTokens"] as number) ?? 0,
              completionTokens: (data["completionTokens"] as number) ?? 0,
              llmCalls: (data["llmCalls"] as number) ?? 0,
              streamingAnswer: "",
            })
            set((s) => ({ runs: appendRunTrace(s.runs, data["runId"] as string, { kind: "answer", text: data["answer"] as string }) }))
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "run.failed":
            store.clearStreamingAnswer()
            if (!isTerminalInfrastructureError(data["error"] as string)) {
              store.addTrace({ kind: "error", text: data["error"] as string })
            }
            store.upsertRun({
              id: data["runId"] as string,
              status: RunStatus.Failed,
              error: data["error"] as string,
              stepCount: data["stepCount"] as number,
              completedAt: timestamp,
              totalTokens: (data["totalTokens"] as number) ?? 0,
              promptTokens: (data["promptTokens"] as number) ?? 0,
              completionTokens: (data["completionTokens"] as number) ?? 0,
              llmCalls: (data["llmCalls"] as number) ?? 0,
              streamingAnswer: "",
            })
            if (!isTerminalInfrastructureError(data["error"] as string)) {
              set((s) => ({ runs: appendRunTrace(s.runs, data["runId"] as string, { kind: "error", text: data["error"] as string }) }))
            }
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "run.cancelled":
            store.clearStreamingAnswer()
            store.upsertRun({
              id: data["runId"] as string,
              status: RunStatus.Cancelled,
              completedAt: timestamp,
              streamingAnswer: "",
            })
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "answer.chunk": {
            const chunk = data["chunk"] as string
            if (!chunk) break
            store.appendStreamingChunk(chunk)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) {
              runAnswerBuf.set(runId, (runAnswerBuf.get(runId) ?? "") + chunk)
              scheduleAnswerFlush(set)
            }
            break
          }

          case "stream.reset":
            // The LLM response that was streaming had tool calls — it was
            // intermediate reasoning, not the final answer. Clear the buffer.
            store.clearStreamingAnswer()
            // Also drop any chunks that arrived before this reset but
            // haven't yet been flushed by the next requestAnimationFrame —
            // otherwise they get re-applied on top of the cleared answer
            // and surface as a garbled fragment of the discarded reasoning
            // (visible in the chat between a tool call and the next
            // iteration as e.g. "PRO blocks temp D'll-only").
            {
              const resetRunId = (data["runId"] as string) ?? get().activeRunId
              if (resetRunId) runAnswerBuf.delete(resetRunId)
              else runAnswerBuf.clear()
            }
            set((s) => ({
              runs: s.activeRunId ? patchRunFields(s.runs, s.activeRunId, { streamingAnswer: "" }) : s.runs,
            }))
            break

          case "step.started": {
            const toolName = (data["action"] as string) ?? "unknown"
            const stepId = data["stepId"] as string
            const input = (data["input"] as Record<string, unknown>) ?? {}
            const { summary: argsSummary } = presentToolCall(toolName, input)
            const argsFormatted = serializeToolCallArgs(input)
            const traceEntry: TraceEntry = { kind: "tool-call", invocationId: stepId, toolCallId: null, tool: toolName, argsSummary, argsFormatted }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            store.upsertStep({
              id: data["stepId"] as string,
              name: data["name"] as string ?? "Step",
              action: data["action"] as string ?? "",
              input,
              output: {},
              error: null,
              status: RunStatus.Running,
              startedAt: timestamp,
            } as Step)
            if (runId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: [...(s.runs.find((run) => run.id === runId)?.stepData ?? []), {
                    id: data["stepId"] as string,
                    name: data["name"] as string ?? "Step",
                    action: data["action"] as string ?? "",
                    input,
                    output: {},
                    error: null,
                    status: RunStatus.Running,
                    order: 0,
                    startedAt: timestamp,
                    completedAt: null,
                  } as Step],
                }),
              }))
            }
            break
          }

          case "step.completed": {
            const output = (data["output"] as Record<string, unknown>) ?? {}
            const result = (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
            const runId = (data["runId"] as string) ?? get().activeRunId
            const traceEntry: TraceEntry = { kind: "tool-result", invocationId: data["stepId"] as string | undefined, text: result }
            store.addTrace(traceEntry)
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            store.upsertStep({
              id: data["stepId"] as string,
              name: data["name"] as string ?? "Step",
              action: data["action"] as string ?? "",
              input: (data["input"] as Record<string, unknown>) ?? {},
              output,
              error: null,
              status: RunStatus.Completed,
              completedAt: timestamp,
            } as Step)
            if (runId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: (s.runs.find((run) => run.id === runId)?.stepData ?? []).map((step) =>
                    step.id === data["stepId"]
                      ? { ...step, output, error: null, status: RunStatus.Completed, completedAt: timestamp }
                      : step,
                  ),
                }),
              }))
            }
            break
          }

          case "sync.agent.preview": {
            // Agent ran sync_preview from chat — populate the Sync widget form
            // so the user can open it and see the full visual diff.
            store.setEnvSyncForm({
              planId: data["planId"] as string,
              source: data["source"] as string || store.envSyncForm.source,
              target: data["target"] as string || store.envSyncForm.target,
              entityType: data["entityType"] as string || store.envSyncForm.entityType,
              entityId: "",
            })
            break
          }

          case "sync.agent.execute.started": {
            // Agent started sync_execute — set the planId so widget knows what's running
            const startPlanId = data["planId"] as string
            store.setEnvSyncForm({ planId: startPlanId })
            set({ agentSyncExecStarted: startPlanId })
            break
          }

          case "sync.agent.execute.completed": {
            set({
              agentSyncExec: {
                planId: data["planId"] as string,
                success: Boolean(data["success"]),
                result: data["result"] as string ?? "",
              },
              agentSyncExecStarted: null,
            })
            break
          }

          case "step.failed": {
            const errText = (data["error"] as string) ?? "unknown error"
            const runId = (data["runId"] as string) ?? get().activeRunId
            const traceEntry: TraceEntry = { kind: "tool-error", invocationId: data["stepId"] as string | undefined, text: errText }
            store.addTrace(traceEntry)
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            store.upsertStep({
              id: data["stepId"] as string,
              name: data["name"] as string ?? "Step",
              action: data["action"] as string ?? "",
              input: (data["input"] as Record<string, unknown>) ?? {},
              output: (data["output"] as Record<string, unknown>) ?? {},
              status: RunStatus.Failed,
              error: errText,
              completedAt: timestamp,
            } as Step)
            if (runId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: (s.runs.find((run) => run.id === runId)?.stepData ?? []).map((step) =>
                    step.id === data["stepId"]
                      ? { ...step, output: (data["output"] as Record<string, unknown>) ?? {}, status: RunStatus.Failed, error: errText, completedAt: timestamp }
                      : step,
                  ),
                }),
              }))
            }
            break
          }

          case "tool_call.executing": {
            const tcRunId = data["runId"] as string
            const toolCallId = data["toolCallId"] as string
            const toolName = data["toolName"] as string
            if (tcRunId && toolCallId) {
              const next = new Map(get().executingToolCalls)
              next.set(toolCallId, { runId: tcRunId, toolCallId, toolName })
              set({ executingToolCalls: next })
              set((s) => ({
                runs: mapRunTrace(s.runs, tcRunId, (trace) => {
                  const nextTrace = [...trace]
                  for (let i = nextTrace.length - 1; i >= 0; i--) {
                    const entry = nextTrace[i]
                    if (entry.kind === "tool-call" && entry.toolCallId == null && entry.tool === toolName) {
                      nextTrace[i] = { ...entry, toolCallId }
                      break
                    }
                  }
                  return nextTrace
                }),
              }))
            }
            break
          }

          case "tool_call.completed": {
            const tcId = data["toolCallId"] as string
            if (tcId) {
              const next = new Map(get().executingToolCalls)
              next.delete(tcId)
              set({ executingToolCalls: next })
            }
            break
          }

          case "tool_call.killed": {
            const toolCallId = data["toolCallId"] as string
            if (toolCallId) {
              const next = new Map(get().executingToolCalls)
              next.delete(toolCallId)
              set({ executingToolCalls: next, pendingKill: null })
            }
            break
          }

          case "audit":
            store.addAudit({
              actor: data["actor"] as string,
              action: data["action"] as string,
              detail: data["detail"] as Record<string, unknown> ?? {},
              timestamp,
            })
            break

          case "agent.thinking": {
            // formatLogEntry already adds the log entry for thinking;
            // this handler only adds the thinking content to the trace.
            const content = data["content"] as string
            if (content) {
              const traceEntry: TraceEntry = { kind: "thinking", text: content }
              store.addTrace(traceEntry)
              const runId = (data["runId"] as string) ?? get().activeRunId
              if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            }
            break
          }

          case "agent.bus.message": {
            // Inter-agent bus message — append to live BusFeed. Help
            // protocol additionally fires `agent.help.requested`, which
            // bumps the unread counter; do NOT bump it from here or it
            // would double-count.
            const msg: BusMessage = {
              id: data["messageId"] as string,
              runId: data["runId"] as string,
              topic: data["topic"] as string,
              protocol: data["protocol"] as string,
              fromRunId: data["fromRunId"] as string,
              fromAgent: data["fromAgent"] as string,
              content: data["content"] as string,
              replyTo: (data["replyTo"] as string | null) ?? null,
              timestamp: (data["timestamp"] as number) ?? Date.parse(timestamp),
            }
            // Avoid double-add when agent.help.requested arrives right after.
            // We dedupe by id.
            set((s) => s.busMessages.some((m) => m.id === msg.id)
              ? s
              : { busMessages: [...s.busMessages, msg].slice(-500) })
            break
          }

          case "agent.help.requested": {
            // Same payload as agent.bus.message but routed to a
            // dedicated event so the UI can highlight it. Bump the
            // help-unread badge; the message itself was already added
            // by the agent.bus.message case (which fires first).
            set((s) => ({ helpUnread: s.helpUnread + 1 }))
            break
          }

          case "notification": {
            store.addNotification({
              id: data["id"] as string,
              type: data["notificationType"] as string,
              title: data["title"] as string,
              message: data["message"] as string,
              runId: (data["runId"] as string) ?? null,
              stepId: (data["stepId"] as string) ?? null,
              actions: (data["actions"] as Notification["actions"]) ?? [],
              read: false,
              createdAt: timestamp,
            })
            break
          }

          case "delegation.started": {
            const traceEntry: TraceEntry = {
              kind: "delegation-start",
              goal: data["goal"] as string,
              depth: data["depth"] as number,
              tools: (data["tools"] as string[]) ?? [],
              agentId: data["agentId"] as string | undefined,
              agentName: data["agentName"] as string | undefined,
            }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            break
          }

          case "delegation.ended": {
            const traceEntry: TraceEntry = {
              kind: "delegation-end",
              depth: data["depth"] as number,
              status: data["status"] as "done" | "error",
              answer: data["answer"] as string | undefined,
              error: data["error"] as string | undefined,
            }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            break
          }

          case "delegation.iteration": {
            const traceEntry: TraceEntry = {
              kind: "delegation-iteration",
              depth: data["depth"] as number,
              iteration: data["iteration"] as number,
              maxIterations: data["maxIterations"] as number,
            }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            break
          }

          case "delegation.parallel-started": {
            const traceEntry: TraceEntry = {
              kind: "delegation-parallel-start",
              depth: data["depth"] as number,
              taskCount: data["taskCount"] as number,
              goals: data["goals"] as string[],
            }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            break
          }

          case "delegation.parallel-ended": {
            const traceEntry: TraceEntry = {
              kind: "delegation-parallel-end",
              depth: data["depth"] as number,
              taskCount: data["taskCount"] as number,
              fulfilled: data["fulfilled"] as number,
              rejected: data["rejected"] as number,
            }
            store.addTrace(traceEntry)
            const runId = (data["runId"] as string) ?? get().activeRunId
            if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            break
          }

          case "planner.started": {
            // Decision trace already arrives via debug.trace; this event is
            // only used for audit/status widgets — do NOT add a second trace.
            break
          }

          case "planner.completed": {
            // Pipeline result already arrives via debug.trace; this event is
            // only used for audit/status widgets — do NOT add a second trace.
            break
          }

          case "planner.validation.failed": {
            // Validation diagnostics are already emitted in debug.trace as
            // planner-validation-failed; keep this event for event-driven widgets.
            break
          }

          case "planner.validation.remediated": {
            // Remediation details are already emitted in debug.trace as
            // planner-validation-remediated; keep this event for event widgets.
            break
          }

          case "usage.updated": {
            // Usage trace entry now arrives via debug.trace; this handler
            // only updates the liveUsage summary counters.
            set({
              liveUsage: {
                promptTokens: (data["promptTokens"] as number) ?? 0,
                completionTokens: (data["completionTokens"] as number) ?? 0,
                totalTokens: (data["totalTokens"] as number) ?? 0,
                llmCalls: (data["llmCalls"] as number) ?? 0,
              },
            })
            break
          }

          case "user_input.required": {
            const traceEntry: TraceEntry = {
              kind: "user-input-request",
              question: data["question"] as string,
              options: data["options"] as string[] | undefined,
              sensitive: data["sensitive"] as boolean | undefined,
            }
            store.addTrace(traceEntry)
            const runId = data["runId"] as string
            if (runId) {
              runTraceBuf.push({ runId, entry: traceEntry })
              scheduleRunFlush(set)
            }
            set({
              pendingInput: {
                runId: data["runId"] as string,
                question: data["question"] as string,
                options: (data["options"] as string[]) ?? undefined,
                sensitive: data["sensitive"] as boolean | undefined,
              },
            })
            break
          }

          case "user_input.response": {
            const runId = data["runId"] as string
            const traceEntry: TraceEntry = {
              kind: "user-input-response",
              text: "Response sent",
            }
            store.addTrace(traceEntry)
            if (runId) {
              runTraceBuf.push({ runId, entry: traceEntry })
              scheduleRunFlush(set)
            }
            set({ pendingInput: null })
            break
          }

          case "debug.trace": {
            const entry = data["entry"] as import("./types").TraceEntry
            if (entry) {
              const isCoherentToken = (entry as { kind?: string }).kind === "coherent-generation-token"
              if (!isCoherentToken) {
                store.addTrace(entry)
              }
              const runId = data["runId"] as string | undefined
              if (runId) {
                if (isCoherentToken) {
                  const token = (entry as { token?: string }).token ?? ""
                  if (token) {
                    runCoherentBuf.set(runId, (runCoherentBuf.get(runId) ?? "") + token)
                    scheduleRunFlush(set)
                  }
                } else {
                  runTraceBuf.push({ runId, entry })
                  scheduleRunFlush(set)
                }
              }
              if (runId && entry.kind === "workspace_diff") {
                const pendingCount =
                  entry.diff.added.length + entry.diff.modified.length + entry.diff.deleted.length
                store.upsertRun({ id: runId, pendingWorkspaceChanges: pendingCount })
              }
              if (runId && entry.kind === "workspace_diff_applied") {
                store.upsertRun({ id: runId, pendingWorkspaceChanges: 0 })
              }
            }
            break
          }
        }
      },
    }),
    {
      name: "mia-dashboard",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<AppState>
        return {
          ...currentState,
          ...persisted,
          envSyncForm: {
            ...DEFAULT_ENV_SYNC_FORM,
            ...(persisted.envSyncForm ?? {}),
            entityId: "",
            planId: null,
          },
        }
      },
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
        selectedAgentId: state.selectedAgentId,
        activeThreadId: state.activeThreadId,
        workspaceThreadId: state.workspaceThreadId,
        threadSidebarCollapsed: state.threadSidebarCollapsed,
        ioeLayout: state.ioeLayout,
        envSyncForm: { ...state.envSyncForm, entityId: "", planId: null },
      }),
    },
  ),
)
