import { Activity, MoreVertical, Shield, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api, createEventStream, createPopoutEventRelay } from "./api"
import { AdminLoginModal } from "./components/AdminLoginModal"
import { Canvas, type CanvasHandle } from "./components/Canvas"
import { MobileNav } from "./components/MobileNav"
import { PolicyEditor } from "./components/PolicyEditor"
import { Toolbar } from "./components/Toolbar"
import { UsageModal } from "./components/UsageModal"
import { WelcomeFlow } from "./components/WelcomeFlow"
import { WidgetCatalog } from "./components/WidgetCatalog"
import { WidgetModal } from "./components/WidgetModal"
import { restoreDashboardState, startDashboardSync } from "./dashboardSync"
import { useIsMobile } from "./hooks/useIsMobile"
import { useMe } from "./hooks/useMe"
import { useStore } from "./store"
import type { AuditEntry, LogEntry, Step, WidgetType } from "./types"
import { widgetRegistry } from "./widgets"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "term-chat": "MI:A Chat",
  "agent-viz": "Agent Viz",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
  "operator-env": "IOE",
  "debug-inspector": "Trace",
  "mymi-db": "MyMI DB",
  "active-users": "Active Users",
  "env-sync": "Sync",
  "operation-log": "Pipelines",
}

const SYNC_CHANNEL = "mia-active-run"

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
  const handleEvent = useStore((s) => s.handleEvent)
  const setRuns = useStore((s) => s.setRuns)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setSteps = useStore((s) => s.setSteps)
  const setLogs = useStore((s) => s.setLogs)
  const setAudit = useStore((s) => s.setAudit)
  const setTrace = useStore((s) => s.setTrace)
  const setNotifications = useStore((s) => s.setNotifications)
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const canvasRef = useRef<CanvasHandle>(null)
  const isMobile = useIsMobile()
  const [mobileWidgetIdx, setMobileWidgetIdx] = useState(0)
  const [mobileCatalogOpen, setMobileCatalogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [adminLoginOpen, setAdminLoginOpen] = useState(false)
  const { me, needsWelcome, refresh: refreshMe, setIdentity, switchUser } = useMe()

  const popOut = getPopOutWidget()

  // Phase state machine — single source of truth for all transitions.
  //   "loading" — initial fetch; blank screen
  //   "login"  — needs identity; WelcomeFlow handles login + intro as one flow
  //   "shell"  — fully authenticated, dashboard visible
  type Phase = "loading" | "login" | "shell" | "outro" | "switching" | "reveal"
  const [phase, setPhase] = useState<Phase>(() => {
    if (!!popOut) return "loading" // popout goes straight to shell
    return "loading"
  })

  // After initial load, decide starting phase.
  useEffect(() => {
    if (!me) return // still loading
    if (phase === "loading") {
      // Check if arriving from ui-term → play reveal animation
      const flag = "mia:ui-transition"
      try {
        if (window.localStorage.getItem(flag)) {
          window.localStorage.removeItem(flag)
          if (!needsWelcome) {
            setPhase("reveal")
            return
          }
        }
      } catch { /* ignore */ }
      setPhase(needsWelcome ? "login" : "shell")
    } else if (needsWelcome && phase === "shell") {
      setPhase("login")
    }
  }, [me, needsWelcome, phase])

  const handleSwitchUser = useCallback(() => {
    setPhase("outro")
  }, [])

  // Switch to ui-term — play mosaic cover inward, then navigate.
  const handleSwitchUi = useCallback(() => {
    setPhase("switching")
  }, [])

  // Ctrl+Shift+A → admin login modal (fallback when UPN whitelist unavailable).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault()
        setAdminLoginOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Connect event stream — main window uses SSE, popouts use BroadcastChannel relay.
  //
  // Identity is bound to the SSE connection at the moment the EventSource is
  // opened (the server reads req.session and stamps the client). When the
  // welcome modal sets the cookie (sid + upn), every fresh HTTP request after
  // it carries the new identity, but the long-lived SSE socket still has the
  // OLD anonymous identity attached server-side. New runs are owned by the
  // new sid/upn → the broadcast filter drops every event for this client and
  // the chat sits forever on "Thinking". Re-create the stream whenever
  // identity changes so the server re-stamps the new client.
  useEffect(() => {
    const stream = popOut
      ? createPopoutEventRelay(handleEvent, setConnected)
      : createEventStream(handleEvent, setConnected)
    return () => stream.close()
  }, [handleEvent, setConnected, popOut, me?.sessionId, me?.upn])

  // Load initial runs + auto-select the most recent. Re-runs on identity
  // change so each user only sees runs the server scopes to them.
  useEffect(() => {
    if (!me) return
    api.listRuns().then(async (runs) => {
      setRuns(runs)
      // Reset run-specific UI state on identity change. NOTE: we deliberately
      // don't reset `logs` — LiveLogs is a platform-wide event stream backed
      // by `event_log` (sync, system, audit, all runs) and is hydrated by
      // a separate effect below. Resetting it here would also wipe other
      // users' visibility into pending sync events on a single workstation.
      const currentActive = useStore.getState().activeRunId
      const stillVisible = currentActive && runs.some((r) => r.id === currentActive)
      if (!stillVisible) {
        setActiveRun(null)
        setSteps([]); setAudit([]); setTrace([])
      }
      if (runs.length > 0 && !useStore.getState().activeRunId) {
        const latest = runs[0]
        setActiveRun(latest.id)
        try {
          const [detail, trace] = await Promise.all([
            api.getRun(latest.id),
            api.getRunTrace(latest.id),
          ])
          setSteps(detail.data.steps ?? [])
          // Merge — never replace — so backfilled platform events survive.
          if (detail.logs?.length) useStore.getState().mergeLogs(detail.logs)
          setAudit(detail.audit ?? [])
          setTrace(trace as import("./types").TraceEntry[])
        } catch { /* ignore */ }
      }
    }).catch(() => {})
  }, [me?.sessionId, me?.upn, setRuns, setActiveRun, setSteps, setAudit, setTrace])

  // Reload notifications on identity change so each user only sees their own.
  useEffect(() => {
    if (!me) return
    api.listNotifications(50).then(setNotifications).catch(() => {})
  }, [me?.sessionId, me?.upn, setNotifications])

  // Restore the EnvSync widget to the user's most recent manual sync run.
  // Mirrors the agent loop's auto-select-latest-run behaviour but for
  // operator-driven syncs (which live in `sync_runs`, not `runs`). Only
  // runs when the persisted form has no planId of its own — never clobbers
  // an in-progress preview the user was working on.
  useEffect(() => {
    if (!me) return
    const current = useStore.getState().envSyncForm
    if (current.planId) return // already have a plan in flight — leave it alone
    api.syncRuns(1).then((rows) => {
      const latest = rows[0]
      if (!latest) return
      // Only restore if it belongs to this user (or is unowned, e.g. legacy rows).
      if (latest.actorUpn && me.upn && latest.actorUpn !== me.upn) return
      useStore.getState().setEnvSyncForm({
        planId: latest.planId,
        source: latest.source,
        target: latest.target,
        entityType: latest.entityType,
        entityId: latest.entityId,
      })
    }).catch(() => {})
  }, [me?.sessionId, me?.upn])

  // Backfill the LiveLogs widget on cold start with recent persisted events
  // (sync runs, agent runs, audit, system) so the log isn't empty after a
  // server/page restart. Runs once per identity. Live events still come
  // through the SSE stream — `hydrateLogsFromEvents` dedups against any
  // entries already added to the live `logs` array.
  useEffect(() => {
    if (!me) return
    api.recentEvents(500).then((res) => {
      useStore.getState().hydrateLogsFromEvents(res.events)
    }).catch(() => {})
  }, [me?.sessionId, me?.upn])

  // Restore dashboard layout from server + start auto-sync.
  // Re-runs when identity changes (welcome modal submit / switch user) so
  // each user gets their own per-user layout instead of sharing one.
  useEffect(() => {
    if (!me) return
    restoreDashboardState().then(() => startDashboardSync())
  }, [me?.sessionId, me?.upn])

  // Pop-out: restore state from main window, then follow active run changes
  useEffect(() => {
    if (!popOut) return

    // Restore state transferred by the main window via localStorage
    const raw = localStorage.getItem("mia-popout-state")
    if (raw) {
      localStorage.removeItem("mia-popout-state")
      try {
        const stashed = JSON.parse(raw)
        if (stashed.activeRunId) setActiveRun(stashed.activeRunId)
        if (stashed.logs) setLogs(stashed.logs)
        if (stashed.steps) setSteps(stashed.steps)
        if (stashed.audit) setAudit(stashed.audit)
        if (stashed.trace) setTrace(stashed.trace as import("./types").TraceEntry[])
      } catch { /* ignore corrupt data */ }
    }
    // No API fallback — popout receives live events via BroadcastChannel relay.
    // If no stashed state, the popout starts empty and accumulates from the stream.

    // Load runs list for widgets that need it
    api.listRuns().then((runs) => setRuns(runs)).catch(() => {})

    // Sync from main window — receive full live state on activeRunId change
    const sync = new BroadcastChannel(SYNC_CHANNEL)
    sync.onmessage = (e) => {
      const msg = e.data as {
        activeRunId: string
        logs?: LogEntry[]
        steps?: Step[]
        audit?: AuditEntry[]
        trace?: import("./types").TraceEntry[]
      }
      if (!msg.activeRunId) return
      setActiveRun(msg.activeRunId)
      if (msg.logs) setLogs(msg.logs)
      if (msg.steps) setSteps(msg.steps)
      if (msg.audit) setAudit(msg.audit)
      if (msg.trace) setTrace(msg.trace)
    }
    return () => sync.close()
  }, [popOut?.type, popOut?.runId, setRuns, setActiveRun, setSteps, setLogs, setAudit, setTrace])

  // Main window: broadcast full live state to pop-outs on activeRunId change
  useEffect(() => {
    if (popOut) return // only main window broadcasts
    const unsub = useStore.subscribe(
      (state, prev) => {
        if (state.activeRunId && state.activeRunId !== prev.activeRunId) {
          const sync = new BroadcastChannel(SYNC_CHANNEL)
          sync.postMessage({
            activeRunId: state.activeRunId,
            logs: state.logs,
            steps: state.steps,
            audit: state.audit,
            trace: state.trace,
          })
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

  // ── Phase-based rendering ──────────────────────────────────────
  if (phase === "loading") {
    return <div className="h-screen" style={{ background: "var(--bg)" }} />
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
      <>
      <div className="flex flex-col h-[100dvh] bg-base">
        {/* Compact header */}
        <header className="flex items-center gap-3 px-4 h-12 bg-surface shrink-0 select-none">
          <div className="shrink-0 min-w-0">
            <span className="text-sm font-semibold text-text tracking-wide">
              MI<span className="text-accent">:A</span>
            </span>
          </div>
          <div className="flex-1 min-w-0 flex justify-center px-2">
            {currentWidget && (
              <span className="block max-w-full truncate text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">
                {WIDGET_LABELS[currentWidget.type]}
              </span>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-3">
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
                    {me?.isAdmin && (
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-overlay-2"
                      onClick={() => { setUsageOpen(true); setMobileMenuOpen(false) }}
                    >
                      <Activity size={15} /> Usage
                    </button>
                    )}
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-overlay-2"
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
                className="px-6 py-3 text-sm text-text-secondary border border-border rounded-xl active:bg-overlay-2"
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
      {phase === "login" && (
        <WelcomeFlow
          key="login-mobile"
          onSubmit={async (displayName, upn) => { await setIdentity(displayName, upn) }}
          onDone={() => setPhase("shell")}
        />
      )}
      {phase === "outro" && (
        <WelcomeFlow
          key="outro-mobile"
          mode="outro"
          onSubmit={async () => {}}
          onDone={async () => {
            try { await switchUser() } catch { /* ignore */ }
            setPhase("login")
          }}
        />
      )}
      {phase === "reveal" && (
        <WelcomeFlow
          key="reveal-mobile"
          mode="reveal"
          onSubmit={async () => {}}
          onDone={() => setPhase("shell")}
        />
      )}
      </>
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────
  return (
    <>

    <div className="flex flex-col h-screen bg-base">
      <Toolbar onAddWidget={() => canvasRef.current?.openCatalog()} onSwitchUser={handleSwitchUser} onSwitchUi={handleSwitchUi} me={me} />
      <Canvas ref={canvasRef} />
      <WidgetModal />
      {adminLoginOpen && (
        <AdminLoginModal
          onClose={() => setAdminLoginOpen(false)}
          onSuccess={() => { setAdminLoginOpen(false); refreshMe() }}
        />
      )}
    </div>
    {phase === "login" && (
      <WelcomeFlow
        key="login"
        onSubmit={async (displayName, upn) => { await setIdentity(displayName, upn) }}
        onDone={() => setPhase("shell")}
      />
    )}
    {phase === "outro" && (
      <WelcomeFlow
        key="outro"
        mode="outro"
        onSubmit={async () => {}}
        onDone={async () => {
          try { await switchUser() } catch { /* ignore */ }
          setPhase("login")
        }}
      />
    )}
    {phase === "switching" && (
      <WelcomeFlow
        key="switching"
        mode="outro"
        onSubmit={async () => {}}
        onDone={() => {
          try { window.localStorage.setItem("mia:ui", "term") } catch { /* ignore */ }
          try { window.localStorage.setItem("mia:ui-transition", "1") } catch { /* ignore */ }
          const { protocol, hostname, port, pathname } = window.location
          const url = port === "5179"
            ? `${protocol}//${hostname}:5180${pathname}`
            : `${protocol}//${hostname}${port ? ":" + port : ""}${pathname}?ui=term`
          window.location.assign(url)
        }}
      />
    )}
    {phase === "reveal" && (
      <WelcomeFlow
        key="reveal"
        mode="reveal"
        onSubmit={async () => {}}
        onDone={() => setPhase("shell")}
      />
    )}
    </>
  )
}
