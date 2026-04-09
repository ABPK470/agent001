/**
 * Global state store — zustand.
 *
 * Single source of truth for the entire dashboard:
 * views, widgets, runs, logs, audit, connection status.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type {
    AuditEntry,
    LayoutItem,
    LogEntry,
    Notification,
    Run,
    Step,
    TraceEntry,
    ViewConfig,
    Widget,
    WidgetType,
    WsEvent,
} from "./types"
import { randomId } from "./util"

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

  // Steps (for active run)
  steps: Step[]
  setSteps: (steps: Step[]) => void
  upsertStep: (step: Partial<Step> & { id: string }) => void

  // Logs (for active run)
  logs: LogEntry[]
  addLog: (log: LogEntry) => void
  setLogs: (logs: LogEntry[]) => void

  // Audit (for active run)
  audit: AuditEntry[]
  addAudit: (entry: AuditEntry) => void
  setAudit: (entries: AuditEntry[]) => void

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

  // Tool calls that are currently executing and can be killed
  executingToolCalls: Map<string, { runId: string; toolCallId: string; toolName: string }>
  pendingKill: { runId: string; toolCallId: string; toolName: string } | null
  setPendingKill: (info: { runId: string; toolCallId: string; toolName: string } | null) => void

  // Raw WebSocket event log (platform dev)
  wsEventLog: WsEvent[]
  clearWsEventLog: () => void

  // IOE layout persistence (survives view switches + page reload)
  ioeLayout: IoeLayout
  setIoeLayout: (patch: Partial<IoeLayout>) => void

  // WebSocket event handler
  handleWsEvent: (event: WsEvent) => void
}

/** Persisted IOE panel layout. */
export interface IoeLayout {
  sidebarSection: string
  sidebarVisible: boolean
  bottomVisible: boolean
  chatVisible: boolean
  editorTab: string
  editorSplit: boolean
  editorRightTab: string
  bottomTab: string
  bottomSplit: boolean
  bottomRightTab: string
  sidebarWidth: number
  bottomHeight: number
  chatWidth: number
}

const DEFAULT_IOE_LAYOUT: IoeLayout = {
  sidebarSection: "runs",
  sidebarVisible: true,
  bottomVisible: true,
  chatVisible: true,
  editorTab: "trace",
  editorSplit: false,
  editorRightTab: "llm-calls",
  bottomTab: "output",
  bottomSplit: false,
  bottomRightTab: "audit",
  sidebarWidth: 260,
  bottomHeight: 200,
  chatWidth: 300,
}

// ── Default view ─────────────────────────────────────────────────

const DEFAULT_VIEW_ID = "default"

function makeDefaultView(): ViewConfig {
  return {
    id: DEFAULT_VIEW_ID,
    name: "Main",
    widgets: [],
    layouts: {},
  }
}

// ── Widget default sizes ─────────────────────────────────────────

const WIDGET_DEFAULTS: Record<WidgetType, { w: number, h: number, minW: number, minH: number }> = {
  "agent-chat":    { w: 4, h: 8,  minW: 3, minH: 5 },
  "run-status":    { w: 4, h: 4,  minW: 2, minH: 3 },
  "agent-trace":   { w: 6, h: 10, minW: 4, minH: 5 },
  "agent-viz":     { w: 6, h: 8,  minW: 4, minH: 5 },
  "live-logs":     { w: 6, h: 8,  minW: 3, minH: 4 },
  "audit-trail":   { w: 6, h: 8,  minW: 4, minH: 4 },
  "step-timeline": { w: 4, h: 10, minW: 3, minH: 5 },
  "tool-stats":    { w: 4, h: 6,  minW: 3, minH: 4 },
  "run-history":   { w: 4, h: 8,  minW: 3, minH: 4 },
  "command-center": { w: 6, h: 10, minW: 4, minH: 6 },
  "trajectory-replay": { w: 8, h: 10, minW: 5, minH: 6 },
  "operator-env": { w: 12, h: 10, minW: 6, minH: 6 },
  "debug-inspector": { w: 6, h: 10, minW: 4, minH: 6 },
  "platform-dev-log": { w: 8, h: 10, minW: 4, minH: 5 },
  "universe-viz": { w: 12, h: 10, minW: 8, minH: 6 },
  "code-seq-diagram": { w: 12, h: 12, minW: 8, minH: 6 },
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
        views: s.views.map((v) =>
          v.id === viewId ? { ...v, layouts: { ...v.layouts, lg: layouts } } : v,
        ),
      })),

      // Agent selection
      selectedAgentId: null,
      setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),

      // Runs
      runs: [],
      activeRunId: null,
      setRuns: (runs) => set({ runs }),
      setActiveRun: (activeRunId) => set({ activeRunId }),
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
        // New run — always select it so the UI shows it immediately
        return {
          runs: [run as Run, ...s.runs],
          activeRunId: run.id,
        }
      }),

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

      // Logs
      logs: [],
      addLog: (log) => set((s) => ({ logs: [...s.logs, log] })),
      setLogs: (logs) => set({ logs }),

      // Audit
      audit: [],
      addAudit: (entry) => set((s) => ({ audit: [...s.audit, entry] })),
      setAudit: (audit) => set({ audit }),

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

      // Executing tool calls + kill
      executingToolCalls: new Map(),
      pendingKill: null,
      setPendingKill: (info) => set({ pendingKill: info }),

      // Raw WS event log
      wsEventLog: [],
      clearWsEventLog: () => set({ wsEventLog: [] }),

      // IOE layout
      ioeLayout: { ...DEFAULT_IOE_LAYOUT },
      setIoeLayout: (patch) => set((s) => ({ ioeLayout: { ...s.ioeLayout, ...patch } })),

      // WebSocket event handler
      handleWsEvent: (event) => {
        const { type, data, timestamp } = event
        const store = get()

        // Record raw event for PlatformDevLog
        set({ wsEventLog: [...store.wsEventLog, event].slice(-2000) })

        // Log every event
        store.addLog({ level: "info", message: `[${type}] ${JSON.stringify(data)}`, timestamp })

        switch (type) {
          case "run.queued":
            // Clear previous run's live state so Live tab starts fresh
            store.setTrace([])
            store.setSteps([])
            store.setLogs([])
            store.setAudit([])
            store.resetLiveUsage()
            store.addTrace({ kind: "goal", text: data["goal"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              goal: data["goal"] as string,
              status: "pending",
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
            })
            break

          case "run.started":
            store.upsertRun({
              id: data["runId"] as string,
              status: "running",
            })
            break

          case "run.completed":
            store.addTrace({ kind: "answer", text: data["answer"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              status: "completed",
              answer: data["answer"] as string,
              stepCount: data["stepCount"] as number,
              pendingWorkspaceChanges: (data["pendingWorkspaceChanges"] as number) ?? 0,
              completedAt: timestamp,
              totalTokens: (data["totalTokens"] as number) ?? 0,
              promptTokens: (data["promptTokens"] as number) ?? 0,
              completionTokens: (data["completionTokens"] as number) ?? 0,
              llmCalls: (data["llmCalls"] as number) ?? 0,
            })
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "run.failed":
            store.addTrace({ kind: "error", text: data["error"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              status: "failed",
              error: data["error"] as string,
              stepCount: data["stepCount"] as number,
              completedAt: timestamp,
              totalTokens: (data["totalTokens"] as number) ?? 0,
              promptTokens: (data["promptTokens"] as number) ?? 0,
              completionTokens: (data["completionTokens"] as number) ?? 0,
              llmCalls: (data["llmCalls"] as number) ?? 0,
            })
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "run.cancelled":
            store.addTrace({ kind: "error", text: "Run cancelled by user" })
            store.upsertRun({
              id: data["runId"] as string,
              status: "cancelled",
              completedAt: timestamp,
            })
            set({ pendingInput: null, executingToolCalls: new Map(), pendingKill: null })
            break

          case "step.started": {
            const toolName = (data["action"] as string) ?? "unknown"
            const input = (data["input"] as Record<string, unknown>) ?? {}
            const argsFormatted = JSON.stringify(input, null, 2)
            const keys = Object.keys(input)
            const argsSummary = keys.length > 0
              ? keys.length === 1 ? `${keys[0]}=${JSON.stringify(input[keys[0]])}`.slice(0, 60) : `${keys.length} args`
              : ""
            store.addTrace({ kind: "tool-call", tool: toolName, argsSummary, argsFormatted })
            store.upsertStep({
              id: data["stepId"] as string,
              name: data["name"] as string ?? "Step",
              action: data["action"] as string ?? "",
              status: "running",
              startedAt: timestamp,
            } as Step)
            break
          }

          case "step.completed": {
            const output = (data["output"] as Record<string, unknown>) ?? {}
            const result = (output["result"] as string) ?? (Object.keys(output).length > 0 ? JSON.stringify(output) : "done")
            store.addTrace({ kind: "tool-result", text: result })
            store.upsertStep({
              id: data["stepId"] as string,
              status: "completed",
              completedAt: timestamp,
            } as Step)
            break
          }

          case "step.failed": {
            const errText = (data["error"] as string) ?? "unknown error"
            store.addTrace({ kind: "tool-error", text: errText })
            store.upsertStep({
              id: data["stepId"] as string,
              status: "failed",
              error: data["error"] as string,
              completedAt: timestamp,
            } as Step)
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
            // iteration + usage entries now arrive via debug.trace; this
            // handler only adds the thinking content + log entry.
            const content = data["content"] as string
            if (content) {
              store.addTrace({ kind: "thinking", text: content })
            }
            store.addLog({
              level: "thinking",
              message: content,
              timestamp,
            })
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
            store.addTrace({
              kind: "delegation-start",
              goal: data["goal"] as string,
              depth: data["depth"] as number,
              tools: (data["tools"] as string[]) ?? [],
              agentId: data["agentId"] as string | undefined,
              agentName: data["agentName"] as string | undefined,
            })
            break
          }

          case "delegation.ended": {
            store.addTrace({
              kind: "delegation-end",
              depth: data["depth"] as number,
              status: data["status"] as "done" | "error",
              answer: data["answer"] as string | undefined,
              error: data["error"] as string | undefined,
            })
            break
          }

          case "delegation.iteration": {
            store.addTrace({
              kind: "delegation-iteration",
              depth: data["depth"] as number,
              iteration: data["iteration"] as number,
              maxIterations: data["maxIterations"] as number,
            })
            break
          }

          case "delegation.parallel-started": {
            store.addTrace({
              kind: "delegation-parallel-start",
              depth: data["depth"] as number,
              taskCount: data["taskCount"] as number,
              goals: data["goals"] as string[],
            })
            break
          }

          case "delegation.parallel-ended": {
            store.addTrace({
              kind: "delegation-parallel-end",
              depth: data["depth"] as number,
              taskCount: data["taskCount"] as number,
              fulfilled: data["fulfilled"] as number,
              rejected: data["rejected"] as number,
            })
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
            store.addTrace({
              kind: "user-input-request",
              question: data["question"] as string,
              options: data["options"] as string[] | undefined,
              sensitive: data["sensitive"] as boolean | undefined,
            })
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
            set({ pendingInput: null })
            break
          }

          case "debug.trace": {
            const entry = data["entry"] as import("./types").TraceEntry
            if (entry) {
              store.addTrace(entry)
              const runId = data["runId"] as string | undefined
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
      name: "agent001-dashboard",
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
        selectedAgentId: state.selectedAgentId,
        ioeLayout: state.ioeLayout,
      }),
    },
  ),
)
