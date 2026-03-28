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

  // Trace (rich agent execution log)
  trace: TraceEntry[]
  addTrace: (entry: TraceEntry) => void
  setTrace: (entries: TraceEntry[]) => void

  // WebSocket event handler
  handleWsEvent: (event: WsEvent) => void
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
  "live-logs":     { w: 6, h: 8,  minW: 3, minH: 4 },
  "audit-trail":   { w: 6, h: 8,  minW: 4, minH: 4 },
  "step-timeline": { w: 4, h: 10, minW: 3, minH: 5 },
  "tool-stats":    { w: 4, h: 6,  minW: 3, minH: 4 },
  "run-history":   { w: 4, h: 8,  minW: 3, minH: 4 },
}

const GRID_COLS = 12

/** Find first position where a widget of size (w, h) fits without overlapping existing items. */
function findFirstFit(existing: LayoutItem[], w: number, h: number): { x: number; y: number } {
  // Build occupancy set from existing items
  const occupied = new Set<string>()
  let maxY = 0
  for (const item of existing) {
    for (let row = item.y; row < item.y + item.h; row++) {
      for (let col = item.x; col < item.x + item.w; col++) {
        occupied.add(`${col},${row}`)
      }
    }
    maxY = Math.max(maxY, item.y + item.h)
  }

  // Scan rows then columns, find first position where (w x h) block is fully free
  for (let y = 0; y <= maxY + 1; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      let fits = true
      outer: for (let row = y; row < y + h; row++) {
        for (let col = x; col < x + w; col++) {
          if (occupied.has(`${col},${row}`)) {
            fits = false
            break outer
          }
        }
      }
      if (fits) return { x, y }
    }
  }

  // Fallback: place below everything
  return { x: 0, y: maxY }
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
        const widget: Widget = { id: randomId(), type }
        const defaults = WIDGET_DEFAULTS[type]
        const view = s.views.find((v) => v.id === viewId)
        const existing = view?.layouts["lg"] ?? []
        const { x, y } = findFirstFit(existing, defaults.w, defaults.h)
        const layout: LayoutItem = {
          i: widget.id,
          x,
          y,
          ...defaults,
        }
        return {
          views: s.views.map((v) =>
            v.id === viewId
              ? {
                  ...v,
                  widgets: [...v.widgets, widget],
                  layouts: {
                    ...v.layouts,
                    lg: [...(v.layouts["lg"] ?? []), layout],
                  },
                }
              : v,
          ),
        }
      }),
      removeWidget: (viewId, widgetId) => set((s) => ({
        views: s.views.map((v) =>
          v.id === viewId
            ? {
                ...v,
                widgets: v.widgets.filter((w) => w.id !== widgetId),
                layouts: Object.fromEntries(
                  Object.entries(v.layouts).map(([k, items]) => [
                    k,
                    items.filter((item) => item.i !== widgetId),
                  ]),
                ),
              }
            : v,
        ),
      })),
      updateLayouts: (viewId, layouts) => set((s) => ({
        views: s.views.map((v) =>
          v.id === viewId ? { ...v, layouts: { ...v.layouts, lg: layouts } } : v,
        ),
      })),

      // Runs
      runs: [],
      activeRunId: null,
      setRuns: (runs) => set({ runs }),
      setActiveRun: (activeRunId) => set({ activeRunId }),
      upsertRun: (run) => set((s) => {
        const idx = s.runs.findIndex((r) => r.id === run.id)
        if (idx >= 0) {
          const updated = [...s.runs]
          updated[idx] = { ...updated[idx], ...run }
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

      // Trace
      trace: [],
      addTrace: (entry) => set((s) => ({ trace: [...s.trace, entry] })),
      setTrace: (trace) => set({ trace }),

      // WebSocket event handler
      handleWsEvent: (event) => {
        const { type, data, timestamp } = event
        const store = get()

        // Log every event
        store.addLog({ level: "info", message: `[${type}] ${JSON.stringify(data)}`, timestamp })

        switch (type) {
          case "run.queued":
            store.addTrace({ kind: "goal", text: data["goal"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              goal: data["goal"] as string,
              status: "pending",
              answer: null,
              stepCount: 0,
              error: null,
              parentRunId: (data["resumedFrom"] as string) ?? null,
              createdAt: timestamp,
              completedAt: null,
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
              completedAt: timestamp,
            })
            break

          case "run.failed":
            store.addTrace({ kind: "error", text: data["error"] as string })
            store.upsertRun({
              id: data["runId"] as string,
              status: "failed",
              error: data["error"] as string,
              stepCount: data["stepCount"] as number,
              completedAt: timestamp,
            })
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

          case "audit":
            store.addAudit({
              actor: data["actor"] as string,
              action: data["action"] as string,
              detail: data["detail"] as Record<string, unknown> ?? {},
              timestamp,
            })
            break

          case "agent.thinking": {
            const iteration = data["iteration"] as number | undefined
            if (iteration !== undefined) {
              store.addTrace({ kind: "iteration", current: iteration + 1, max: 30 })
            }
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
        }
      },
    }),
    {
      name: "agent001-dashboard",
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
      }),
    },
  ),
)
