/**
 * Global state store — zustand.
 *
 * Single source of truth for the entire dashboard:
 * views, widgets, runs, logs, audit, connection status.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  reduceEnvSyncPreviewProgress,
  type EnvSyncPreviewProgress,
} from "./env-sync-preview-progress.js"
import {
  createSyncProgressState,
  finalizeSyncProgress,
  reduceSyncSseEvent,
  SYNC_TRACE_TOOLS,
  syncProgressToTraceEntry,
  type SyncProgressState
} from "./sync-trace-progress.js"
import { pendingApprovalFromEvent, type PendingToolApproval } from "./pending-approval.js"
import { api } from "../client/index"
import { readSseRunId, readSseStepId, lookupEventDescriptor } from "@mia/shared-types"
import {
  traceEntryFromStepCompleted,
  traceEntryFromStepFailed,
  traceEntryFromStepStarted,
} from "../lib/sse-run-trace.js"
import { isDefaultThreadTitle, threadTitleFromGoal } from "../lib/thread-title.js"
import { RunStatus } from "../enums"
import type {
  AuditEntry,
  BusMessage,
  LogEntry,
  Notification,
  Run,
  RunDetail,
  SseEvent,
  Step,
  SyncPlan,
  Thread,
  TraceEntry,
  WidgetType,
} from "../types"
export type { PendingToolApproval } from "./pending-approval.js"

/**
 * A deliverable file the agent produced and promoted to the durable
 * attachment store (e.g. an export_query_to_file CSV). Enough to render a
 * download chip in chat; the bytes are fetched on click via
 * `api.downloadAttachment(id, name)`.
 */
export interface GeneratedAttachment {
  id: string
  name: string
  sizeBytes: number
  mediaType: string
  runId: string | null
}

function truncateSyncToolResult(text: string, max = 1200): string {
  const t = text.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + "…"
}

function normalizePendingInputOptions(options: string[] | undefined): string[] | undefined {
  if (!options?.length) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of options) {
    const option = raw.trim()
    if (!option || seen.has(option)) continue
    seen.add(option)
    out.push(option)
  }
  return out.length > 0 ? out : undefined
}

function upsertSyncProgressTrace(runs: Run[], runId: string, entry: TraceEntry): Run[] {
  if (entry.kind !== "sync-progress") return runs
  return mapRunTrace(runs, runId, (trace) => {
    const idx = trace.findIndex((t) => t.kind === "sync-progress" && t.invocationId === entry.invocationId)
    if (idx >= 0) {
      const next = [...trace]
      next[idx] = entry
      return next
    }
    return trace.concat(entry)
  })
}

function upsertGlobalSyncProgressTrace(trace: TraceEntry[], entry: TraceEntry): TraceEntry[] {
  if (entry.kind !== "sync-progress") return trace
  const idx = trace.findIndex((t) => t.kind === "sync-progress" && t.invocationId === entry.invocationId)
  if (idx >= 0) {
    const next = [...trace]
    next[idx] = entry
    return next
  }
  return trace.concat(entry)
}

function applySyncSseToStore(
  get: () => AppState,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  type: string,
  data: Record<string, unknown>
): void {
  if (type.startsWith("sync.preview.") && get().envSyncPreviewProgress) {
    const next = reduceEnvSyncPreviewProgress(get().envSyncPreviewProgress, type, data)
    if (next && next !== get().envSyncPreviewProgress) {
      set({ envSyncPreviewProgress: next })
    }
  }

  if (!type.startsWith("sync.")) return
  const active = get().activeSyncInvocation
  const activeRunId = get().activeRunId
  if (!active || !activeRunId || active.runId !== activeRunId) return

  const prev = get().syncProgressStates.get(active.invocationId) ?? createSyncProgressState(active.invocationId, active.tool)
  const nextState = reduceSyncSseEvent(prev, type, data)
  const entry = syncProgressToTraceEntry(nextState)
  const states = new Map(get().syncProgressStates)
  states.set(active.invocationId, nextState)

  set({
    syncProgressStates: states,
    trace: upsertGlobalSyncProgressTrace(get().trace, entry),
    runs: upsertSyncProgressTrace(get().runs, activeRunId, entry)
  })
}

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
 * widgets (StepTimeline, ToolTimelinePanel,
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

/** Coalesce concurrent bootstrapThreads() calls (App + chat shell both trigger on login). */
let threadsBootstrapInflight: Promise<void> | null = null

// ── Store shape ──────────────────────────────────────────────────

interface AppState {
  // Connection
  connected: boolean
  setConnected: (v: boolean) => void

  // Runs
  runs: Run[]
  activeRunId: string | null
  setRuns: (runs: Run[]) => void
  setActiveRun: (id: string | null) => void
  upsertRun: (run: Partial<Run> & { id: string }) => void
  /** Insert a pending run row immediately after POST /runs — before SSE run.queued. */
  beginOptimisticRun: (input: {
    id: string
    goal: string
    threadId: string
  }) => void
  /** Start a run via API and insert the optimistic row. */
  startRun: (
    goal: string,
    attachmentIds?: string[],
    threadId?: string
  ) => Promise<{ runId: string; threadId: string }>

  // Threads (home chat workspaces)
  threads: Thread[]
  activeThreadId: string | null
  threadSidebarCollapsed: boolean
  threadsPanelOpenNonce: number
  threadTitleShellId: string | null
  threadTitleReveal: { threadId: string; text: string } | null
  setThreads: (threads: Thread[]) => void
  upsertThread: (thread: Thread) => void
  setActiveThreadId: (id: string | null) => void
  setThreadSidebarCollapsed: (collapsed: boolean) => void
  openThreadsPanel: () => void
  selectThread: (id: string | null) => Promise<void>
  selectRun: (runId: string, threadId: string) => Promise<void>
  bootstrapThreads: () => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  createNewThread: () => Promise<string>
  beginThreadTitleShell: (threadId: string) => void
  revealThreadTitleFromGoal: (threadId: string, goal: string) => void
  clearThreadTitleAnimation: (threadId: string, finalTitle: string) => void

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

  /** Blocked tool call awaiting operator approve/deny (require_approval policy). */
  pendingToolApproval: PendingToolApproval | null
  approvalModalOpen: boolean
  approvalModalDismissed: boolean
  setPendingToolApproval: (pending: PendingToolApproval | null) => void
  clearPendingToolApproval: () => void
  setApprovalModalOpen: (open: boolean) => void
  upsertPendingToolApproval: (patch: Partial<PendingToolApproval> & { runId: string; stepId: string }) => void

  /** Policy editor modal — shared so notifications can open it. */
  policyEditorOpen: boolean
  setPolicyEditorOpen: (open: boolean) => void

  // Dismissed workspace diff run IDs (session-only — not persisted)
  dismissedWorkspaceDiffRunIds: Set<string>
  dismissWorkspaceDiff: (runId: string) => void

  // Tool calls that are currently executing and can be killed
  executingToolCalls: Map<string, { runId: string; toolCallId: string; toolName: string }>
  pendingKill: { runId: string; toolCallId: string; toolName: string } | null
  setPendingKill: (info: { runId: string; toolCallId: string; toolName: string } | null) => void

  /** Active sync tool invocation for coalesced trace progress (session-only). */
  activeSyncInvocation: { runId: string; invocationId: string; tool: string } | null
  syncProgressStates: Map<string, SyncProgressState>

  // Raw SSE event log (platform dev)
  sseEventLog: SseEvent[]
  clearSseEventLog: () => void

  // Live streaming answer (chunks from LLM before run.completed)
  streamingAnswer: string
  appendStreamingChunk: (chunk: string) => void
  clearStreamingAnswer: () => void

  // EnvSync widget form state (survives view switches + page reload)
  envSyncForm: EnvSyncFormState
  setEnvSyncForm: (patch: Partial<EnvSyncFormState>) => void
  /** In-memory plan body for the sync widget — survives widget remounts within a session. */
  envSyncPlan: SyncPlan | null
  setEnvSyncPlan: (plan: SyncPlan | null) => void
  /** Live preview progress from sync.preview.* SSE while widget preview is running. */
  envSyncPreviewProgress: EnvSyncPreviewProgress | null
  setEnvSyncPreviewProgress: (progress: EnvSyncPreviewProgress | null) => void

  // Last sync execute result from agent (chat-triggered). Cleared when widget resets.
  agentSyncExec: { planId: string; success: boolean; result: string } | null
  clearAgentSyncExec: () => void
  /** planId of an in-progress agent-triggered execute. Set on execute.started, cleared on execute.completed/failed. */
  agentSyncExecStarted: string | null
  /** Bumped when a sync execute reaches a terminal state (history modal listens). */
  syncHistoryRevision: number

  // Agent-generated deliverable attachments (CSV/MD/… exports promoted via
  // export_query_to_file or promote_attachment). Keyed by runId so the chat
  // can render download chips under the run that produced them. Populated
  // live from the `attachment.promoted` SSE event and reconciled on run
  // completion via listAttachments({ runId }).
  generatedAttachmentsByRun: Record<string, GeneratedAttachment[]>
  addGeneratedAttachment: (runId: string, att: GeneratedAttachment) => void
  setGeneratedAttachments: (runId: string, list: GeneratedAttachment[]) => void
  clearGeneratedAttachments: (runId: string) => void

  // SSE event handler
  handleEvent: (event: SseEvent) => void
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
  /** Last successfully-built plan id; re-hydrated only when set by preview/agent (not on cold start). */
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

// ── Store ────────────────────────────────────────────────────────

// ── Trace batching buffer ────────────────────────────────────────
const traceBuf: TraceEntry[] = []
let traceFlushScheduled = false

// Per-run trace batching (microtask) — coalesces a burst of trace events
// into a single store update so React rerenders once per tick instead of
// once per event. Critical when many tools/delegations run concurrently.
const runTraceBuf: Array<{ runId: string; entry: TraceEntry }> = []
const runAnswerBuf = new Map<string, string>()
let runFlushScheduled = false
let answerFlushGeneration = 0
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
    if (traceBatch.length === 0) return
    set((s) => {
      let runs = s.runs
      const grouped = new Map<string, TraceEntry[]>()
      for (const { runId, entry } of traceBatch) {
        const arr = grouped.get(runId) ?? []
        arr.push(entry)
        grouped.set(runId, arr)
      }
      for (const [runId, entries] of grouped) {
        runs = appendRunTraceMany(runs, runId, entries)
      }
      return { runs }
    })
  })
}

function scheduleAnswerFlush(set: (fn: (s: AppState) => Partial<AppState>) => void) {
  if (answerFlushScheduled) return
  answerFlushScheduled = true
  const generation = answerFlushGeneration
  const flush = () => {
    answerFlushScheduled = false
    if (generation !== answerFlushGeneration) return
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
  if (type.startsWith("bridge.")) return "bridge"
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

/** step.* / tool_call.* summaries already include tool + verb — don't wrap again. */
function isSelfContainedStreamSummary(type: string, message: string): boolean {
  if (type.startsWith("step.") || type.startsWith("tool_call.") || type.startsWith("tool.")) {
    return /\b(started|completed|failed|executing|killed|done)\b/i.test(message)
  }
  return false
}

/**
 * Build a LogEntry with the correct type, error flag, and a clean
 * human-readable message via the shared event catalog.
 * Returns null for high-frequency spam (answer.chunk, most debug.trace).
 * Unknown types → JSON preview (never silent).
 */
export function formatLogEntry(
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

  if (type === "answer.chunk") return null

  if (type === "debug.trace") {
    const entry = data["entry"] as Record<string, unknown> | undefined
    if (!entry) return null
    const kind = typeof entry["kind"] === "string" ? entry["kind"] : ""
    // High-volume loop noise — Trace / OpLog own these.
    if (
      kind === "tool-call" ||
      kind === "tool-result" ||
      kind === "tool-error" ||
      kind === "llm-request" ||
      kind === "llm-response" ||
      kind === "thinking" ||
      kind === "iteration" ||
      kind === "usage"
    ) {
      return null
    }
    const d = lookupEventDescriptor(kind || "unknown")
    const summary = d.summary(entry)
    return {
      type: t,
      message: summary ? `${d.label} — ${summary}` : d.label,
      timestamp,
      error: d.severity === "error" || undefined,
    }
  }

  const d = lookupEventDescriptor(type)
  const isUnknown = d.id === "unknown" || (d.label === "Event" && !SSE_KNOWN(type))
  let message = d.summary(data)
  if (!message || message === "event") {
    message = d.label !== "Event" ? d.label : ""
  }
  if (isUnknown || !message) {
    try {
      const raw = JSON.stringify(data)
      message = raw.length > 160 ? `${raw.slice(0, 159)}…` : raw || type
    } catch {
      message = type
    }
  } else if (d.label && !message.startsWith(d.label) && !isSelfContainedStreamSummary(type, message)) {
    // Prefix short fragments ("cancelled") with the catalog label. Skip when the
    // summary already names the tool + verb (`query_mssql started · …`).
    message = `${d.label} — ${message}`
  }

  return {
    type: t,
    message,
    timestamp,
    error: d.severity === "error" || undefined,
  }
}

function SSE_KNOWN(type: string): boolean {
  return lookupEventDescriptor(type).id === type
}

// ── Store ────────────────────────────────────────────────────────

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Connection
      connected: false,
      setConnected: (connected) => set({ connected }),

      // Runs
      runs: [],
      activeRunId: null,
      // Merge incoming run rows into the store WITHOUT clobbering live,
      // SSE-accumulated per-run fields. `api.listRuns()` returns the row
      // metadata only (id/goal/status/counts) — it never carries the live
      // `trace`, `streamingAnswer`, `stepData`, or
      // `auditTrail` that we accumulate from the event stream. A plain
      // `set({ runs })` would wipe all of that, which is exactly what
      // happened when widgets like RunHistory re-fetched the run list on
      // mount: switching to a view containing RunHistory and then back
      // to TermChat would erase the active run's narrative + tool calls.
      //
      // `runs` is a multi-thread cache. Callers pass the list for the *active*
      // thread (listThreadRuns / listRuns({ threadId })). Replace that thread's
      // rows only — keep other threads so switching back does not flash empty.
      // Consumers must filter by threadId (TermChat, ThreadRunsPanel, …).
      //
      // Also keep in-memory-only rows for the active thread (in-flight SSE /
      // not yet in the latest list response).
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
            stepData: existing.stepData?.length ? existing.stepData : incoming.stepData,
            auditTrail: existing.auditTrail?.length ? existing.auditTrail : incoming.auditTrail,
          }
        })
        const scopeThreadId = s.activeThreadId
        const otherThreadRuns = scopeThreadId
          ? s.runs.filter((r) => r.threadId !== scopeThreadId)
          : []
        const orphans = scopeThreadId
          ? s.runs.filter((r) => !incomingIds.has(r.id) && r.threadId === scopeThreadId)
          : s.runs.filter((r) => !incomingIds.has(r.id))
        return { runs: [...otherThreadRuns, ...merged, ...orphans] }
      }),
      setActiveRun: (activeRunId) => {
        if (activeRunId) {
          const state = get()
          const run = state.runs.find((r) => r.id === activeRunId)
          if (
            state.activeThreadId &&
            run?.threadId &&
            run.threadId !== state.activeThreadId
          ) {
            return
          }
        }
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
              hasCheckpoint: d.hasCheckpoint,
              rollbackAvailable: d.rollbackAvailable,
              error: d.error,
              answer: d.answer,
              completedAt: d.completedAt,
            }),
          }))
        }).catch((err: unknown) => { console.error("[mia]", err) })
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
        // termchat, switched views, came back, and my run is gone" — a
        // sync.run started elsewhere silently became the new active run.
        const appendToThread =
          s.activeThreadId && run.threadId === s.activeThreadId
        return {
          runs: appendToThread ? [...s.runs, run as Run] : s.runs,
          activeRunId: s.activeRunId ?? (appendToThread ? run.id : s.activeRunId),
        }
      }),

      beginOptimisticRun: (input) => {
        const now = new Date().toISOString()
        get().upsertRun({
          id: input.id,
          goal: input.goal,
          threadId: input.threadId,
          status: RunStatus.Pending,
          answer: null,
          stepCount: 0,
          error: null,
          pendingWorkspaceChanges: 0,
          parentRunId: null,
          createdAt: now,
          completedAt: null,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          llmCalls: 0,
          trace: [{ kind: "goal", text: input.goal }],
          streamingAnswer: "",
          auditTrail: [],
          stepData: [],
        })
        set({ activeRunId: input.id })
      },

      startRun: async (goal, attachmentIds, threadId) => {
        const tid = threadId ?? get().activeThreadId
        if (!tid) throw new Error("No thread selected")
        const { runId } = await api.startRun(goal, attachmentIds, tid)
        get().beginOptimisticRun({ id: runId, goal, threadId: tid })
        return { runId, threadId: tid }
      },

      threads: [],
      activeThreadId: null,
      threadSidebarCollapsed: false,
      threadsPanelOpenNonce: 0,
      threadTitleShellId: null as string | null,
      threadTitleReveal: null as { threadId: string; text: string } | null,
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
      openThreadsPanel: () =>
        set((s) => ({
          threadsPanelOpenNonce: s.threadsPanelOpenNonce + 1,
          threadSidebarCollapsed: false,
        })),
      selectThread: async (threadId) => {
        // Never blank the multi-thread run cache on switch — TermChat keys
        // emptiness off displayRuns.length, so runs:[] paints the empty hero
        // for a few ms before listThreadRuns returns. Previous thread cannot
        // paint into the next: widgets filter by activeThreadId / threadId.
        const cached = threadId
          ? get().runs
              .filter((r) => r.threadId === threadId)
              .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          : []
        set({
          activeThreadId: threadId,
          activeRunId: cached.length > 0 ? cached[cached.length - 1]!.id : null,
          steps: [],
          trace: [],
          audit: [],
          pendingInput: null,
          ...(threadId ? {} : { runs: [] }),
        })
        if (!threadId) return
        try {
          const runs = await api.listThreadRuns(threadId)
          // The user may have selected another thread while this request was
          // in flight. Never let a stale response replace the current thread.
          if (get().activeThreadId !== threadId) return
          // Preserve SSE-owned fields (streamingAnswer, trace, steps, audit)
          // when refreshing server metadata. A plain set({ runs }) erased
          // visible in-progress answers during thread navigation.
          get().setRuns(runs)
          if (runs.length > 0) {
            // listThreadRuns is newest-first; activate the most recent run
            // (not runs.at(-1), which would be the oldest).
            const newest = runs.reduce((a, b) =>
              new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
            )
            get().setActiveRun(newest.id)
          } else {
            set({ activeRunId: null })
          }
        } catch {
          // Drop only this thread's rows; keep the rest of the cache.
          if (get().activeThreadId === threadId) get().setRuns([])
        }
      },
      createNewThread: async () => {
        const thread = await api.createThread()
        set((s) => ({ threads: [thread, ...s.threads] }))
        await get().selectThread(thread.id)
        return thread.id
      },
      beginThreadTitleShell: (threadId) => {
        set({ threadTitleShellId: threadId, threadTitleReveal: null })
      },
      revealThreadTitleFromGoal: (threadId, goal) => {
        const text = threadTitleFromGoal(goal)
        if (isDefaultThreadTitle(text)) return
        const shellId = get().threadTitleShellId
        if (shellId === threadId) {
          set({ threadTitleReveal: { threadId, text } })
          return
        }
        const existing = get().threads.find((t) => t.id === threadId)
        if (existing && isDefaultThreadTitle(existing.title)) {
          get().upsertThread({ ...existing, title: text })
        }
      },
      clearThreadTitleAnimation: (threadId, finalTitle) => {
        set((s) => {
          const touches =
            s.threadTitleShellId === threadId || s.threadTitleReveal?.threadId === threadId
          if (!touches) return {}
          const index = s.threads.findIndex((t) => t.id === threadId)
          const threads = [...s.threads]
          if (index >= 0) {
            threads[index] = { ...threads[index]!, title: finalTitle }
          }
          return {
            threads,
            threadTitleShellId: null,
            threadTitleReveal: null,
          }
        })
      },
      bootstrapThreads: async () => {
        if (!threadsBootstrapInflight) {
          threadsBootstrapInflight = (async () => {
            const listed = await api.listThreads()
            set({ threads: listed })
            const persistedId = get().activeThreadId
            const target =
              (persistedId && listed.some((t) => t.id === persistedId) && persistedId) ||
              listed[0]?.id ||
              null
            if (target) {
              await get().selectThread(target)
              return
            }
            await get().createNewThread()
          })().finally(() => {
            threadsBootstrapInflight = null
          })
        }
        await threadsBootstrapInflight
      },
      selectRun: async (runId, threadId) => {
        if (get().activeThreadId !== threadId) {
          await get().selectThread(threadId)
        }
        const run = get().runs.find((r) => r.id === runId)
        if (!run || run.threadId !== threadId) return
        get().setActiveRun(runId)
      },
      deleteThread: async (threadId) => {
        await api.deleteThread(threadId)
        const remaining = get().threads.filter((t) => t.id !== threadId)
        const wasActive = get().activeThreadId === threadId
        if (!wasActive) {
          set({ threads: remaining })
          return
        }
        set({ threads: remaining, activeThreadId: null, activeRunId: null, runs: [] })
        const nextId = remaining[0]?.id
        if (nextId) await get().selectThread(nextId)
        else await get().createNewThread()
      },

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

      pendingToolApproval: null,
      approvalModalOpen: false,
      approvalModalDismissed: false,
      setPendingToolApproval: (pending) => set({
        pendingToolApproval: pending,
        approvalModalOpen: pending !== null && !!pending.approvalId,
        approvalModalDismissed: false,
      }),
      clearPendingToolApproval: () => set({
        pendingToolApproval: null,
        approvalModalOpen: false,
        approvalModalDismissed: false,
      }),
      setApprovalModalOpen: (open) => set((s) => ({
        approvalModalOpen: open,
        approvalModalDismissed: !open && !!s.pendingToolApproval ? true : s.approvalModalDismissed,
      })),
      upsertPendingToolApproval: (patch) => set((s) => {
        const existing = s.pendingToolApproval
        const same = existing && existing.runId === patch.runId && existing.stepId === patch.stepId
        const gotAuthoritativeId = !!patch.approvalId && !(same && existing.approvalId)
        return {
          pendingToolApproval: {
            approvalId: patch.approvalId ?? (same ? existing.approvalId : null),
            runId: patch.runId,
            stepId: patch.stepId,
            toolName: patch.toolName ?? (same ? existing.toolName : "unknown"),
            reason: patch.reason ?? (same ? existing.reason : "Policy requires approval"),
            policyName: patch.policyName ?? (same ? existing.policyName : undefined),
            args: patch.args ?? (same ? existing.args : undefined),
            notificationId: patch.notificationId ?? (same ? existing.notificationId : null),
          },
          approvalModalOpen: gotAuthoritativeId
            ? !s.approvalModalDismissed
            : same
              ? s.approvalModalOpen
              : false,
        }
      }),

      policyEditorOpen: false,
      setPolicyEditorOpen: (open) => set({ policyEditorOpen: open }),

      // Dismissed workspace diff run IDs (session-only)
      dismissedWorkspaceDiffRunIds: new Set<string>(),
      dismissWorkspaceDiff: (runId) => set((s) => ({
        dismissedWorkspaceDiffRunIds: new Set([...s.dismissedWorkspaceDiffRunIds, runId]),
      })),

      // Executing tool calls + kill
      executingToolCalls: new Map(),
      pendingKill: null,
      activeSyncInvocation: null,
      syncProgressStates: new Map(),
      setPendingKill: (info) => set({ pendingKill: info }),

      // Raw WS event log
      sseEventLog: [],
      clearSseEventLog: () => set({ sseEventLog: [] }),

      streamingAnswer: "",
      appendStreamingChunk: (chunk) => set((s) => ({ streamingAnswer: s.streamingAnswer + chunk })),
      clearStreamingAnswer: () => set({ streamingAnswer: "" }),

      envSyncForm: { ...DEFAULT_ENV_SYNC_FORM },
      setEnvSyncForm: (patch) => set((s) => ({ envSyncForm: { ...s.envSyncForm, ...patch } })),
      envSyncPlan: null,
      setEnvSyncPlan: (plan) => set({ envSyncPlan: plan }),
      envSyncPreviewProgress: null,
      setEnvSyncPreviewProgress: (progress) => set({ envSyncPreviewProgress: progress }),

      agentSyncExec: null,
      clearAgentSyncExec: () => set({ agentSyncExec: null }),
      agentSyncExecStarted: null,
      syncHistoryRevision: 0,

      generatedAttachmentsByRun: {},
      addGeneratedAttachment: (runId, att) =>
        set((s) => {
          const prev = s.generatedAttachmentsByRun[runId] ?? []
          if (prev.some((a) => a.id === att.id)) return s
          return {
            generatedAttachmentsByRun: { ...s.generatedAttachmentsByRun, [runId]: [...prev, att] }
          }
        }),
      setGeneratedAttachments: (runId, list) =>
        set((s) => ({
          generatedAttachmentsByRun: { ...s.generatedAttachmentsByRun, [runId]: list }
        })),
      clearGeneratedAttachments: (runId) =>
        set((s) => {
          if (!(runId in s.generatedAttachmentsByRun)) return s
          const next = { ...s.generatedAttachmentsByRun }
          delete next[runId]
          return { generatedAttachmentsByRun: next }
        }),

      // SSE event handler
      handleEvent: (event) => {
        const { type, data, timestamp } = event
        const store = get()

        // Record raw event for PlatformDevLog
        set({ sseEventLog: [...store.sseEventLog, event].slice(-2000) })

        // ── Build a properly-levelled + categorised log entry ──
        const logEntry = formatLogEntry(type, data, timestamp)
        if (logEntry) store.addLog(logEntry)

        if (type.startsWith("sync.")) {
          applySyncSseToStore(get, set, type, data as Record<string, unknown>)
          if (
            type === "sync.execute.completed" ||
            type === "sync.execute.failed" ||
            type === "sync.execute.skipped" ||
            type === "sync.execute.cancelled"
          ) {
            set((s) => ({ syncHistoryRevision: s.syncHistoryRevision + 1 }))
          }
        }

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
            set({ activeSyncInvocation: null, syncProgressStates: new Map() })
            store.clearGeneratedAttachments(data["runId"] as string)
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
              createdAt: timestamp,
              completedAt: null,
              totalTokens: 0,
              promptTokens: 0,
              completionTokens: 0,
              llmCalls: 0,
              trace: [],
              streamingAnswer: "",
              auditTrail: [],
              stepData: [],
              threadId: get().activeThreadId,
            })
            const resumedFrom = data["resumedFrom"] as string | undefined
            if (resumedFrom) {
              store.upsertRun({
                id: resumedFrom,
                status: RunStatus.Cancelled,
                completedAt: timestamp,
              })
              // Follow the resumed child — do not stay on the parked parent.
              if (get().activeRunId === resumedFrom || !get().activeRunId) {
                set({ activeRunId: data["runId"] as string })
              }
            }
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
            store.addTrace({ kind: "answer", text: data["answer"] as string })
            {
              const completedRunId = readSseRunId(data) ?? get().activeRunId
              if (completedRunId) {
                const completedAnswer = data["answer"] as string
                store.upsertRun({
                  id: completedRunId,
                  status: RunStatus.Completed,
                  answer: completedAnswer,
                  stepCount: data["stepCount"] as number,
                  pendingWorkspaceChanges: (data["pendingWorkspaceChanges"] as number) ?? 0,
                  completedAt: timestamp,
                  totalTokens: (data["totalTokens"] as number) ?? 0,
                  promptTokens: (data["promptTokens"] as number) ?? 0,
                  completionTokens: (data["completionTokens"] as number) ?? 0,
                  llmCalls: (data["llmCalls"] as number) ?? 0,
                  streamingAnswer: "",
                })
                set((s) => ({
                  runs: appendRunTrace(s.runs, completedRunId, { kind: "answer", text: completedAnswer }),
                }))
                const existingTraceLen =
                  get().runs.find((r) => r.id === completedRunId)?.trace?.length ?? 0
                if (existingTraceLen < 2) {
                  void api.getRunTrace(completedRunId).then((rawTrace) => {
                    const trace = rawTrace as TraceEntry[]
                    set((s) => ({
                      runs: patchRunFields(s.runs, completedRunId, { trace }),
                      trace: s.activeRunId === completedRunId ? trace : s.trace,
                    }))
                  }).catch((err: unknown) => { console.error("[mia]", err) })
                }
                // Reconcile deliverable attachments for this run from the
                // server — catches any promoted mid-run that SSE missed and
                // drops soft-deleted ones. Best-effort.
                void api.listAttachments({ runId: completedRunId })
                  .then((rows) => {
                    const list: GeneratedAttachment[] = rows
                      .filter((r) => r.scope === "workspace_asset")
                      .map((r) => ({
                        id: r.id,
                        name: r.normalizedName,
                        sizeBytes: r.sizeBytes,
                        mediaType: r.mediaType,
                        runId: completedRunId
                      }))
                    store.setGeneratedAttachments(completedRunId, list)
                  })
                  .catch((err: unknown) => { console.error("[mia]", err) })
              }
            }
            store.clearStreamingAnswer()
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null, activeSyncInvocation: null, syncProgressStates: new Map() })
            if (get().pendingToolApproval?.runId === (data["runId"] as string)) {
              set({ pendingToolApproval: null, approvalModalOpen: false, approvalModalDismissed: false })
            }
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
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null, activeSyncInvocation: null, syncProgressStates: new Map() })
            if (get().pendingToolApproval?.runId === (data["runId"] as string)) {
              set({ pendingToolApproval: null, approvalModalOpen: false, approvalModalDismissed: false })
            }
            break

          case "run.cancelled":
            store.clearStreamingAnswer()
            store.upsertRun({
              id: data["runId"] as string,
              status: RunStatus.Cancelled,
              completedAt: timestamp,
              streamingAnswer: "",
            })
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null, activeSyncInvocation: null, syncProgressStates: new Map() })
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

          case "stream.reset": {
            // The LLM response that was streaming had tool calls — it was
            // intermediate reasoning, not the final answer. Clear the buffer.
            const resetRunId = (data["runId"] as string) ?? get().activeRunId
            answerFlushGeneration++
            answerFlushScheduled = false
            if (resetRunId) runAnswerBuf.delete(resetRunId)
            else runAnswerBuf.clear()
            set((s) => ({
              streamingAnswer: resetRunId && resetRunId === s.activeRunId ? "" : s.streamingAnswer,
              runs: resetRunId
                ? patchRunFields(s.runs, resetRunId, { streamingAnswer: "" })
                : s.runs,
            }))
            break
          }

          case "step.started": {
            const toolName = (data["action"] as string) ?? "unknown"
            const stepId = readSseStepId(data)
            const input = (data["input"] as Record<string, unknown>) ?? {}
            const traceEntry = traceEntryFromStepStarted(data)
            if (traceEntry) {
              store.addTrace(traceEntry)
              const runId = readSseRunId(data) ?? get().activeRunId
              if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            }
            const runId = readSseRunId(data) ?? get().activeRunId
            if (runId && stepId && SYNC_TRACE_TOOLS.has(toolName)) {
              const progress = createSyncProgressState(stepId, toolName)
              const progressEntry = syncProgressToTraceEntry(progress)
              const states = new Map(get().syncProgressStates)
              states.set(stepId, progress)
              set({
                activeSyncInvocation: { runId, invocationId: stepId, tool: toolName },
                syncProgressStates: states,
                trace: upsertGlobalSyncProgressTrace(get().trace, progressEntry),
                runs: upsertSyncProgressTrace(get().runs, runId, progressEntry)
              })
            }
            if (stepId) {
              store.upsertStep({
                id: stepId,
                name: data["name"] as string ?? "Step",
                action: data["action"] as string ?? "",
                input,
                output: {},
                error: null,
                status: RunStatus.Running,
                startedAt: timestamp,
              } as Step)
            }
            if (runId && stepId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: [...(s.runs.find((run) => run.id === runId)?.stepData ?? []), {
                    id: stepId,
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
            const runId = readSseRunId(data) ?? get().activeRunId
            const stepId = readSseStepId(data)
            const active = get().activeSyncInvocation
            if (runId && stepId && active?.invocationId === stepId) {
              const prev = get().syncProgressStates.get(stepId) ?? createSyncProgressState(stepId, active.tool)
              const finalized = finalizeSyncProgress(prev, truncateSyncToolResult(
                (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done"),
              ), false)
              const progressEntry = syncProgressToTraceEntry(finalized)
              set({
                trace: upsertGlobalSyncProgressTrace(get().trace, progressEntry),
                runs: upsertSyncProgressTrace(get().runs, runId, progressEntry)
              })
            }
            const traceEntry = traceEntryFromStepCompleted(data)
            if (traceEntry) {
              store.addTrace(traceEntry)
              if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            }
            if (stepId) {
              store.upsertStep({
                id: stepId,
                name: data["name"] as string ?? "Step",
                action: data["action"] as string ?? "",
                input: (data["input"] as Record<string, unknown>) ?? {},
                output,
                error: null,
                status: RunStatus.Completed,
                completedAt: timestamp,
              } as Step)
            }
            if (runId && stepId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: (s.runs.find((run) => run.id === runId)?.stepData ?? []).map((step) =>
                    step.id === stepId
                      ? { ...step, output, error: null, status: RunStatus.Completed, completedAt: timestamp }
                      : step,
                  ),
                }),
              }))
            }
            set({ activeSyncInvocation: null, syncProgressStates: new Map() })
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
              syncHistoryRevision: get().syncHistoryRevision + 1,
            })
            break
          }

          case "step.failed": {
            const errText = (data["error"] as string) ?? "unknown error"
            const runId = readSseRunId(data) ?? get().activeRunId
            const stepId = readSseStepId(data)
            const active = get().activeSyncInvocation
            if (runId && stepId && active?.invocationId === stepId) {
              const prev = get().syncProgressStates.get(stepId) ?? createSyncProgressState(stepId, active.tool)
              const finalized = finalizeSyncProgress(prev, errText, true)
              const progressEntry = syncProgressToTraceEntry(finalized)
              set({
                trace: upsertGlobalSyncProgressTrace(get().trace, progressEntry),
                runs: upsertSyncProgressTrace(get().runs, runId, progressEntry)
              })
            }
            const traceEntry = traceEntryFromStepFailed(data)
            if (traceEntry) {
              store.addTrace(traceEntry)
              if (runId) set((s) => ({ runs: appendRunTrace(s.runs, runId, traceEntry) }))
            }
            if (stepId) {
              store.upsertStep({
                id: stepId,
                name: data["name"] as string ?? "Step",
                action: data["action"] as string ?? "",
                input: (data["input"] as Record<string, unknown>) ?? {},
                output: (data["output"] as Record<string, unknown>) ?? {},
                error: errText,
                status: RunStatus.Failed,
                completedAt: timestamp,
              } as Step)
            }
            if (runId && stepId) {
              set((s) => ({
                runs: patchRunFields(s.runs, runId, {
                  stepData: (s.runs.find((run) => run.id === runId)?.stepData ?? []).map((step) =>
                    step.id === stepId
                      ? { ...step, output: (data["output"] as Record<string, unknown>) ?? {}, status: RunStatus.Failed, error: errText, completedAt: timestamp }
                      : step,
                  ),
                }),
              }))
            }
            set({ activeSyncInvocation: null, syncProgressStates: new Map() })
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
            const notification: Notification = {
              id: data["id"] as string,
              type: data["notificationType"] as string,
              title: data["title"] as string,
              message: data["message"] as string,
              runId: (data["runId"] as string) ?? null,
              stepId: readSseStepId(data) ?? null,
              actions: (data["actions"] as Notification["actions"]) ?? [],
              read: false,
              createdAt: timestamp,
            }
            store.addNotification(notification)
            if (notification.type === "approval.required" && notification.runId) {
              const approveAction = notification.actions.find((a) => a.action === "approve-run-step")
              const approvalId = approveAction?.data?.approvalId as string | undefined
              const toolMatch = notification.message.match(/^Tool "([^"]+)"/)
              get().upsertPendingToolApproval({
                runId: notification.runId,
                stepId: notification.stepId ?? "",
                approvalId: approvalId ?? null,
                toolName: toolMatch?.[1] ?? "unknown",
                reason: notification.message.replace(/^Tool "[^"]+" needs approval: /, "") || notification.message,
                notificationId: notification.id,
              })
            }
            break
          }

          case "approval.required": {
            const runId = data["runId"] as string
            const stepId = (data["stepId"] as string) ?? ""
            const pending = pendingApprovalFromEvent(data as Record<string, unknown>)
            const existing = get().pendingToolApproval
            get().upsertPendingToolApproval({
              runId,
              stepId,
              approvalId: pending.approvalId ?? existing?.approvalId ?? null,
              toolName: pending.toolName,
              reason: pending.reason,
              policyName: pending.policyName,
              args: pending.args,
              notificationId: existing?.notificationId ?? pending.notificationId ?? null,
            })
            store.upsertRun({ id: runId, status: RunStatus.WaitingForApproval })
            if (!existing || existing.runId !== runId || existing.stepId !== stepId) {
              const traceEntry: TraceEntry = {
                kind: "error",
                text: `Waiting for approval — ${pending.toolName}: ${pending.reason}`,
              }
              store.addTrace(traceEntry)
              if (runId) {
                runTraceBuf.push({ runId, entry: traceEntry })
                scheduleRunFlush(set)
              }
            }
            break
          }

          case "approval.resolved": {
            const runId = data["runId"] as string
            const stepId = (data["stepId"] as string) ?? ""
            const approvalId = data["approvalId"] as string | undefined
            const decision = data["decision"] as string
            const pending = get().pendingToolApproval
            if (
              pending &&
              (pending.approvalId === approvalId ||
                (pending.runId === runId && pending.stepId === stepId))
            ) {
              set({ pendingToolApproval: null, approvalModalOpen: false, approvalModalDismissed: false })
            }
            if (decision === "denied") {
              store.upsertRun({ id: runId, status: RunStatus.Cancelled, completedAt: timestamp })
            }
            break
          }

          case "delegation.started": {
            const traceEntry: TraceEntry = {
              kind: "delegation-start",
              goal: data["goal"] as string,
              depth: data["depth"] as number,
              tools: (data["tools"] as string[]) ?? [],
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
                options: normalizePendingInputOptions(data["options"] as string[] | undefined),
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

          case "attachment.promoted": {
            // A sandbox file (e.g. an export_query_to_file CSV) was promoted
            // to a durable, user-downloadable attachment. Surface it as a
            // download chip under the run that produced it, live.
            const runId = (data["runId"] as string | null) ?? null
            if (runId) {
              store.addGeneratedAttachment(runId, {
                id: data["id"] as string,
                name: (data["normalizedName"] as string) ?? "file",
                sizeBytes: (data["sizeBytes"] as number) ?? 0,
                mediaType: (data["mediaType"] as string) ?? "application/octet-stream",
                runId
              })
            }
            break
          }

          case "debug.trace": {
            const entry = data["entry"] as import("../types").TraceEntry
            if (entry) {
              store.addTrace(entry)
              const runId = data["runId"] as string | undefined
              if (runId) {
                runTraceBuf.push({ runId, entry })
                scheduleRunFlush(set)
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
          envSyncPlan: null,
          envSyncForm: {
            ...DEFAULT_ENV_SYNC_FORM,
            ...(persisted.envSyncForm ?? {}),
            entityId: "",
            planId: null,
          },
        }
      },
      partialize: (state) => ({
        activeThreadId: state.activeThreadId,
        threadSidebarCollapsed: state.threadSidebarCollapsed,
        envSyncForm: { ...state.envSyncForm, entityId: "", planId: null },
      }),
    },
  ),
)

export {
  makeDefaultView,
  pruneUnknownWidgets,
  useLayoutStore,
  WIDGET_DEFAULTS,
} from "./layout-store.js"
