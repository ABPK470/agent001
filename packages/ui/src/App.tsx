import { Activity, MoreVertical, Shield, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, createEventStream, createPopoutEventRelay } from "./api"
import { Canvas, type CanvasHandle } from "./components/Canvas"
import { MobileNav } from "./components/MobileNav"
import { PolicyEditor } from "./components/PolicyEditor"
import { Toolbar } from "./components/Toolbar"
import { UsageModal } from "./components/UsageModal"
import { WelcomeFlow } from "./components/WelcomeFlow"
import { WidgetCatalog } from "./components/WidgetCatalog"
import { WidgetModal } from "./components/WidgetModal"
import { restoreDashboardState, startDashboardSync } from "./dashboardSync"
import { AppPhase } from "./enums"
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
  const { me, loading: meLoading, refresh: refreshMe, logout } = useMe()

  const popOut = getPopOutWidget()
  const currentView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? views[0] ?? null,
    [views, activeViewId],
  )
  const visibleWidgetTypes = useMemo(() => {
    if (popOut) return new Set<WidgetType>([popOut.type])
    return new Set<WidgetType>((currentView?.widgets ?? []).map((widget) => widget.type))
  }, [currentView, popOut])
  const shouldHydrateSelectedRun = visibleWidgetTypes.has("run-status")
    || visibleWidgetTypes.has("operator-env")
    || visibleWidgetTypes.has("run-history")
    || visibleWidgetTypes.has("audit-trail")
    || visibleWidgetTypes.has("step-timeline")
    || visibleWidgetTypes.has("debug-inspector")
    || visibleWidgetTypes.has("tool-stats")
  const shouldRestoreSyncState = visibleWidgetTypes.has("env-sync")
  const shouldHydrateRecentEvents = visibleWidgetTypes.has("live-logs")

  // Phase state machine — v19 simplified.
  //   Loading   — initial whoami fetch in flight; blank screen
  //   Login     — not authenticated; <WelcomeFlow/> renders intro + form
  //   Shell     — authenticated; dashboard visible
  //   Outro     — logout in progress; mosaic covers inward, then logout
  //                  fires and we land back on Login (which plays intro)
  //   Switching — navigating to ui-term; mosaic covers inward, then redirect
  //   Reveal    — arrived from ui-term; mosaic dissolves outward over shell
  const [phase, setPhase] = useState<AppPhase>(AppPhase.Loading)

  // Decide phase from auth state. v19: identity is binary — either we have
  // a verified user (shell) or we don't (login). No welcome modal, no
  // anon fallback, no "reveal" path because there's no longer a separate
  // identity-collection step that runs after the page mounts.
  useEffect(() => {
    if (popOut) { setPhase(AppPhase.Shell); return }
    if (meLoading) return
    // Don't yank a running animation out from under the user just because
    // `me` updated mid-flight. Outro/switching/reveal own their own exit.
    if (phase === AppPhase.Outro || phase === AppPhase.Switching || phase === AppPhase.Reveal) return
    if (me) {
      // During phase=Login with me set, we're mid-intro — the WelcomeFlow
      // is playing its morph + dissolve over the now-rendered shell. Don't
      // flip to Shell here; let WelcomeFlow.onDone do it once the mosaic
      // has fully dissolved. Otherwise we'd unmount the animation halfway.
      if (phase === AppPhase.Login) return
      // First paint after a cross-shell hop — honor the transition flag
      // ui-term sets when it sends us here, so the mosaic dissolve plays.
      if (phase === AppPhase.Loading) {
        try {
          if (window.localStorage.getItem("mia:ui-transition")) {
            window.localStorage.removeItem("mia:ui-transition")
            setPhase(AppPhase.Reveal); return
          }
        } catch { /* ignore */ }
      }
      setPhase(AppPhase.Shell)
    } else {
      setPhase(AppPhase.Login)
    }
  }, [me, meLoading, popOut, phase])

  const handleSwitchUser = useCallback(() => {
    // Cover the shell with the outro animation; the actual logout fires
    // when the animation hits its done frame, so the dashboard stays
    // visible underneath the dissolving mosaic the whole time.
    setPhase(AppPhase.Outro)
  }, [])

  // Switch to ui-term — play mosaic cover inward, then navigate.
  const handleSwitchUi = useCallback(() => {
    setPhase(AppPhase.Switching)
  }, [])

  // Connect event stream — main window uses SSE, popouts use BroadcastChannel relay.
  //
  // Identity is bound to the SSE connection at the moment the EventSource is
  // opened (the server stamps req.session.upn onto the client). Logout/login
  // mints a new sid + may swap upn, so we re-create the stream on every
  // identity transition. The single-input dep [me?.upn] covers all cases
  // because every login/logout cycle changes either upn or null↔upn.
  useEffect(() => {
    const stream = popOut
      ? createPopoutEventRelay(handleEvent, setConnected)
      : createEventStream(handleEvent, setConnected)
    return () => stream.close()
  }, [handleEvent, setConnected, popOut, me?.upn])

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
      if (shouldHydrateSelectedRun && runs.length > 0 && !useStore.getState().activeRunId) {
        const latest = runs[0]
        setActiveRun(latest.id)
      }
    }).catch(() => {})
  }, [me?.upn, setRuns, setActiveRun, setSteps, setAudit, setTrace, shouldHydrateSelectedRun])

  // Reload notifications on identity change so each user only sees their own.
  useEffect(() => {
    if (!me) return
    api.listNotifications(50).then(setNotifications).catch(() => {})
  }, [me?.upn, setNotifications])

  // Restore the EnvSync widget to the user's most recent manual sync run.
  // Mirrors the agent loop's auto-select-latest-run behaviour but for
  // operator-driven syncs (which live in `sync_runs`, not `runs`). Only
  // runs when the persisted form has no planId of its own — never clobbers
  // an in-progress preview the user was working on.
  useEffect(() => {
    if (!me) return
    if (!shouldRestoreSyncState) return
    const current = useStore.getState().envSyncForm
    if (current.planId) return // already have a plan in flight — leave it alone
    api.syncRuns(1).then((rows) => {
      const latest = rows[0]
      if (!latest) return
      // Only restore if it belongs to this user (or is unowned, e.g. legacy rows).
      if (latest.actorUpn !== me.upn) return
      useStore.getState().setEnvSyncForm({
        planId: latest.planId,
        source: latest.source,
        target: latest.target,
        entityType: latest.entityType,
        entityId: latest.entityId,
      })
    }).catch(() => {})
  }, [me?.upn, shouldRestoreSyncState])

  // Backfill the LiveLogs widget on cold start with recent persisted events
  // (sync runs, agent runs, audit, system) so the log isn't empty after a
  // server/page restart. Runs once per identity. Live events still come
  // through the SSE stream — `hydrateLogsFromEvents` dedups against any
  // entries already added to the live `logs` array.
  useEffect(() => {
    if (!me) return
    if (!shouldHydrateRecentEvents) return
    api.recentEvents(500).then((res) => {
      useStore.getState().hydrateLogsFromEvents(res.events)
    }).catch(() => {})
  }, [me?.upn, shouldHydrateRecentEvents])

  // Restore dashboard layout from server + start auto-sync.
  // v19: dashboardIdFor() on the server is `dashboard:${upn}` — single
  // input, no admin special case, no sid fallback. So [me?.upn] is the
  // only dep needed. Every login/logout transition flips it and triggers
  // a re-fetch under the new key.
  useEffect(() => {
    if (!me) return
    restoreDashboardState().then(() => startDashboardSync())
  }, [me?.upn])

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

  // ── Stable WelcomeFlow overlay ──
  // Always at fragment-position 0 in every return below, so React preserves
  // the same component instance as we transition login → (mid-animation
  // shell mounts) → shell. Without this, the body switch would unmount
  // WelcomeFlow halfway through its morph + dissolve.
  const loginOrRegister = async (username: string, password: string) => {
    const post = (url: string, body: Record<string, unknown>) =>
      fetch(url, {
        method:      "POST",
        credentials: "include",
        headers:     { "content-type": "application/json" },
        body:        JSON.stringify(body),
      })
    const login = await post("/api/auth/login", { username, password })
    if (login.ok) { await refreshMe(); return }
    if (login.status === 401) {
      const reg = await post("/api/auth/register", { username, password, displayName: username })
      if (reg.ok) { await refreshMe(); return }
      if (reg.status === 409) {
        // Username exists but login was rejected → wrong password.
        throw new Error("wrong password")
      }
      const body = await reg.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? `sign-up failed (${reg.status})`)
    }
    const body = await login.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `sign-in failed (${login.status})`)
  }
  const welcomeOverlay =
    phase === AppPhase.Login ? (
      <WelcomeFlow
        key="login"
        onSubmit={loginOrRegister}
        onDone={() => setPhase(AppPhase.Shell)}
      />
    ) : phase === AppPhase.Outro ? (
      <WelcomeFlow
        key="outro"
        mode="outro"
        onSubmit={async () => {}}
        onDone={async () => {
          try { await logout() } catch { /* server-side already gone */ }
          setPhase(AppPhase.Login)
        }}
      />
    ) : phase === AppPhase.Switching ? (
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
    ) : phase === AppPhase.Reveal ? (
      <WelcomeFlow
        key="reveal"
        mode="reveal"
        onSubmit={async () => {}}
        onDone={() => setPhase(AppPhase.Shell)}
      />
    ) : null

  // ── Phase-based rendering ──────────────────────────────────────
  // Every branch below wraps with `<>{welcomeOverlay}{body}</>` so the
  // overlay sits at a stable position-0 across all render paths.
  if (phase === AppPhase.Loading) {
    return (
      <>
        {welcomeOverlay}
        <div className="h-screen" style={{ background: "var(--bg)" }} />
      </>
    )
  }
  // Login with no `me` yet: just blank background under the overlay.
  // The moment login succeeds, refreshMe populates `me` and we fall
  // through to the real shell — which paints behind the still-covering
  // mosaic and is then revealed by its dissolve.
  if (phase === AppPhase.Login && !me) {
    return (
      <>
        {welcomeOverlay}
        <div className="h-screen" style={{ background: "var(--bg)" }} />
      </>
    )
  }
  const widgets = currentView?.widgets ?? []

  // Clamp mobile index if widgets were removed
  const clampedIdx = Math.min(mobileWidgetIdx, Math.max(0, widgets.length - 1))
  const currentWidget = widgets[clampedIdx]
  const WidgetComponent = currentWidget ? widgetRegistry[currentWidget.type] : null

  // ── Mobile layout ──
  if (isMobile) {
    return (
      <>
      {welcomeOverlay}
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
        <main className="flex-1 overflow-hidden flex flex-col">
          {widgets.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
              <p className="text-text-secondary text-center">No widgets in this view yet</p>
              <button
                className="px-6 py-3 text-sm text-text-secondary border border-border rounded-xl active:bg-overlay-2"
                onClick={() => setMobileCatalogOpen(true)}
              >
                Add Widget
              </button>
            </div>
          ) : WidgetComponent ? (
            <>
              {/* Intra-view pager — only when this view holds more than
                  one widget. Lets the user step through them on mobile
                  without taking nav space away from view switching. */}
              {widgets.length > 1 && (
                <div className="flex items-center justify-center gap-1.5 py-1.5 shrink-0">
                  {widgets.map((w, i) => (
                    <button
                      key={w.id}
                      onClick={() => setMobileWidgetIdx(i)}
                      aria-label={`Widget ${i + 1}`}
                      className={`h-1.5 rounded-full transition-all ${
                        i === clampedIdx ? "w-6 bg-accent" : "w-1.5 bg-border"
                      }`}
                    />
                  ))}
                </div>
              )}
              <div className="flex-1 min-h-0 p-2">
                <div className="h-full bg-surface rounded-xl overflow-hidden p-3">
                  <WidgetComponent />
                </div>
              </div>
            </>
          ) : null}
        </main>

        {/* Bottom navigation — always visible so the user can switch
            views even when the active view is empty. */}
        <MobileNav
          views={views}
          activeViewId={activeViewId}
          onSelectView={(id) => { useStore.getState().setActiveView(id); setMobileWidgetIdx(0) }}
          onAdd={() => {
            const newId = useStore.getState().addView(`View ${views.length + 1}`)
            useStore.getState().setActiveView(newId)
            setMobileCatalogOpen(true)
          }}
        />

        {mobileCatalogOpen && <WidgetCatalog onClose={() => setMobileCatalogOpen(false)} />}
        {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
        {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      </div>
      </>
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────
  return (
    <>
    {welcomeOverlay}
    <div className="flex flex-col h-screen bg-base">
      <Toolbar onAddWidget={() => canvasRef.current?.openCatalog()} onSwitchUser={handleSwitchUser} onSwitchUi={handleSwitchUi} me={me} />
      <Canvas ref={canvasRef} />
      <WidgetModal />
    </div>
    </>
  )
}
