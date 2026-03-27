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
  "live-logs":     { w: 6, h: 8,  minW: 3, minH: 4 },
  "audit-trail":   { w: 6, h: 8,  minW: 4, minH: 4 },
  "step-timeline": { w: 4, h: 10, minW: 3, minH: 5 },
  "tool-stats":    { w: 4, h: 6,  minW: 3, minH: 4 },
  "run-history":   { w: 4, h: 8,  minW: 3, minH: 4 },
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
        const layout: LayoutItem = {
          i: widget.id,
          x: 0,
          y: Infinity, // bottom
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
        return {
          runs: [run as Run, ...s.runs],
          activeRunId: s.activeRunId ?? run.id,
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

      // WebSocket event handler
      handleWsEvent: (event) => {
        const { type, data, timestamp } = event
        const store = get()

        // Log every event
        store.addLog({ level: "info", message: `[${type}] ${JSON.stringify(data)}`, timestamp })

        switch (type) {
          case "run.queued":
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

          case "run.completed":
            store.upsertRun({
              id: data["runId"] as string,
              status: "completed",
              answer: data["answer"] as string,
              stepCount: data["stepCount"] as number,
              completedAt: timestamp,
            })
            break

          case "run.failed":
            store.upsertRun({
              id: data["runId"] as string,
              status: "failed",
              error: data["error"] as string,
              stepCount: data["stepCount"] as number,
              completedAt: timestamp,
            })
            break

          case "step.started":
            store.upsertStep({
              id: data["stepId"] as string,
              name: data["name"] as string ?? "Step",
              action: data["action"] as string ?? "",
              status: "running",
              startedAt: timestamp,
            } as Step)
            break

          case "step.completed":
            store.upsertStep({
              id: data["stepId"] as string,
              status: "completed",
              completedAt: timestamp,
            } as Step)
            break

          case "step.failed":
            store.upsertStep({
              id: data["stepId"] as string,
              status: "failed",
              error: data["error"] as string,
              completedAt: timestamp,
            } as Step)
            break

          case "audit":
            store.addAudit({
              actor: data["actor"] as string,
              action: data["action"] as string,
              detail: data["detail"] as Record<string, unknown> ?? {},
              timestamp,
            })
            break

          case "agent.thinking":
            store.addLog({
              level: "thinking",
              message: data["content"] as string,
              timestamp,
            })
            break
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
