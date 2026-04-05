import { Activity, MoreVertical, Shield, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api, createWs } from "./api"
import { Canvas, type CanvasHandle } from "./components/Canvas"
import { MobileNav } from "./components/MobileNav"
import { PolicyEditor } from "./components/PolicyEditor"
import { Toolbar } from "./components/Toolbar"
import { UsageModal } from "./components/UsageModal"
import { WidgetCatalog } from "./components/WidgetCatalog"
import { WidgetModal } from "./components/WidgetModal"
import { restoreDashboardState, startDashboardSync } from "./dashboardSync"
import { useIsMobile } from "./hooks/useIsMobile"
import { useStore } from "./store"
import type { WidgetType } from "./types"
import { widgetRegistry } from "./widgets"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "agent-trace": "Agent Trace",
  "agent-viz": "Agent Viz",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
  "command-center": "Command Center",
  "trajectory-replay": "Trajectory Replay",
  "operator-env": "Operator Environment",
  "debug-inspector": "Debug Inspector",
  "platform-dev-log": "Platform Dev Log",
}

const SYNC_CHANNEL = "agent001-active-run"

/** Detect ?widget= param for pop-out mode */
function getPopOutWidget(): { type: WidgetType; runId: string | null } | null {
  const params = new URLSearchParams(window.location.search)
  const type = params.get("widget") as WidgetType | null
  if (!type || !(type in widgetRegistry)) return null
  return { type, runId: params.get("runId") }
}

export function App() {
  const setConnected = useStore((s) => s.setConnected)
  const connected = useStore((s) => s.connected)
  const handleWsEvent = useStore((s) => s.handleWsEvent)
  const setRuns = useStore((s) => s.setRuns)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setSteps = useStore((s) => s.setSteps)
  const setLogs = useStore((s) => s.setLogs)
  const setAudit = useStore((s) => s.setAudit)
  const setTrace = useStore((s) => s.setTrace)
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const canvasRef = useRef<CanvasHandle>(null)
  const isMobile = useIsMobile()
  const [mobileWidgetIdx, setMobileWidgetIdx] = useState(0)
  const [mobileCatalogOpen, setMobileCatalogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  const popOut = getPopOutWidget()

  // Connect WebSocket
  useEffect(() => {
    const ws = createWs(handleWsEvent, setConnected)
    return () => ws.close()
  }, [handleWsEvent, setConnected])

  // Load initial runs + auto-select the most recent
  useEffect(() => {
    api.listRuns().then(async (runs) => {
      setRuns(runs)
      if (runs.length > 0 && !useStore.getState().activeRunId) {
        const latest = runs[0]
        setActiveRun(latest.id)
        try {
          const [detail, trace] = await Promise.all([
            api.getRun(latest.id),
            api.getRunTrace(latest.id),
          ])
          setSteps(detail.data.steps ?? [])
          setLogs(detail.logs ?? [])
          setAudit(detail.audit ?? [])
          setTrace(trace as import("./types").TraceEntry[])
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [setRuns, setActiveRun, setSteps, setLogs, setAudit, setTrace])

  // Restore dashboard layout from server + start auto-sync
  useEffect(() => {
    restoreDashboardState().then(() => startDashboardSync())
  }, [])

  // Pop-out: load latest runs + follow active run from main window
  useEffect(() => {
    if (!popOut) return

    // Load initial runs (same as main window)
    api.listRuns().then(async (runs) => {
      setRuns(runs)
      // Use URL runId as initial hint, otherwise use latest
      const targetId = popOut.runId ?? runs[0]?.id
      if (targetId) {
        setActiveRun(targetId)
        try {
          const [detail, trace] = await Promise.all([
            api.getRun(targetId),
            api.getRunTrace(targetId),
          ])
          setSteps(detail.data.steps ?? [])
          setLogs(detail.logs ?? [])
          setAudit(detail.audit ?? [])
          setTrace(trace as import("./types").TraceEntry[])
        } catch { /* ignore */ }
      }
    }).catch(() => {})

    // Sync activeRunId from main window
    const sync = new BroadcastChannel(SYNC_CHANNEL)
    sync.onmessage = async (e) => {
      const { activeRunId: newId } = e.data as { activeRunId: string }
      if (!newId || newId === useStore.getState().activeRunId) return
      setActiveRun(newId)
      try {
        const [detail, trace] = await Promise.all([
          api.getRun(newId),
          api.getRunTrace(newId),
        ])
        setSteps(detail.data.steps ?? [])
        setLogs(detail.logs ?? [])
        setAudit(detail.audit ?? [])
        setTrace(trace as import("./types").TraceEntry[])
      } catch { /* ignore */ }
    }
    return () => sync.close()
  }, [popOut?.type, popOut?.runId, setRuns, setActiveRun, setSteps, setLogs, setAudit, setTrace])

  // Main window: broadcast activeRunId changes to pop-outs
  useEffect(() => {
    if (popOut) return // only main window broadcasts
    const unsub = useStore.subscribe(
      (state, prev) => {
        if (state.activeRunId && state.activeRunId !== prev.activeRunId) {
          const sync = new BroadcastChannel(SYNC_CHANNEL)
          sync.postMessage({ activeRunId: state.activeRunId })
          sync.close()
        }
      },
    )
    return unsub
  }, [popOut])

  // Pop-out mode: render only the requested widget
  if (popOut) {
    const Widget = widgetRegistry[popOut.type]
    return (
      <div className="flex flex-col h-screen bg-surface p-4">
        <Widget />
      </div>
    )
  }

  const activeView = views.find((v) => v.id === activeViewId)
  const widgets = activeView?.widgets ?? []

  // Clamp mobile index if widgets were removed
  const clampedIdx = Math.min(mobileWidgetIdx, Math.max(0, widgets.length - 1))
  const currentWidget = widgets[clampedIdx]
  const WidgetComponent = currentWidget ? widgetRegistry[currentWidget.type] : null

  // ── Mobile layout ──────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="flex flex-col h-[100dvh] bg-base">
        {/* Compact header */}
        <header className="flex items-center justify-between px-4 h-12 bg-surface shrink-0 select-none">
          <span className="text-sm font-semibold text-text tracking-wide">
            AGENT<span className="text-accent">001</span>
          </span>
          {currentWidget && (
            <span className="text-xs text-text-muted uppercase tracking-wider">
              {WIDGET_LABELS[currentWidget.type]}
            </span>
          )}
          <div className="flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${connected ? "bg-success" : "bg-error"}`}
            />
            <div className="relative">
              <button
                className="p-1.5 -mr-1.5 text-text-muted active:text-text"
                onClick={() => setMobileMenuOpen((v) => !v)}
              >
                {mobileMenuOpen ? <X size={18} /> : <MoreVertical size={18} />}
              </button>
              {mobileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
                  <div className="absolute right-0 top-10 z-50 bg-elevated rounded-xl border border-border shadow-2xl py-1 w-44">
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-white/5"
                      onClick={() => { setUsageOpen(true); setMobileMenuOpen(false) }}
                    >
                      <Activity size={15} /> Usage
                    </button>
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-white/5"
                      onClick={() => { setPolicyOpen(true); setMobileMenuOpen(false) }}
                    >
                      <Shield size={15} /> Policies
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Widget area — full remaining space */}
        <main className="flex-1 overflow-hidden">
          {widgets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
              <p className="text-text-secondary text-center">No widgets yet</p>
              <button
                className="px-6 py-3 text-sm text-text-secondary border border-white/10 rounded-xl active:bg-white/5"
                onClick={() => setMobileCatalogOpen(true)}
              >
                Add Widget
              </button>
            </div>
          ) : WidgetComponent ? (
            <div className="h-full p-2">
              <div className="h-full bg-surface rounded-xl overflow-hidden p-3">
                <WidgetComponent />
              </div>
            </div>
          ) : null}
        </main>

        {/* Bottom navigation */}
        {widgets.length > 0 && (
          <MobileNav
            widgets={widgets}
            activeIndex={clampedIdx}
            onChange={setMobileWidgetIdx}
            onAdd={() => setMobileCatalogOpen(true)}
          />
        )}

        {mobileCatalogOpen && <WidgetCatalog onClose={() => setMobileCatalogOpen(false)} />}
        {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
        {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      </div>
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-base">
      <Toolbar onAddWidget={() => canvasRef.current?.openCatalog()} />
      <Canvas ref={canvasRef} />
      <WidgetModal />
    </div>
  )
}
