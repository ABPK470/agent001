import { Activity, LayoutGrid, MessageSquare, MoreVertical, Shield, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, createEventStream, createPopoutEventRelay } from "../client/index"
import { Canvas, type CanvasHandle } from "./workspace/Canvas"
import { ChatHomePage } from "./home/ChatHomePage"
import { EmptyState } from "../components/EmptyState"
import { MobileNav } from "./workspace/MobileNav"
import { ApprovalRequiredModal } from "../widgets/platform/ApprovalRequiredModal"
import { PolicyEditor } from "../widgets/platform/PolicyEditor"
import { Toolbar } from "./workspace/Toolbar"
import { UsageModal } from "../widgets/platform/UsageModal"
import { PlatformHealthBanner } from "../widgets/platform/PlatformHealthBanner"
import { WelcomeFlow } from "./home/WelcomeFlow"
import { WidgetCatalog } from "./workspace/WidgetCatalog"
import { WidgetModal } from "./workspace/WidgetModal"
import { flushDashboardSave, restoreDashboardState, startDashboardSync } from "./dashboard-sync"
import { AppPhase } from "../enums"
import { ThreadHomePage } from "../widgets/threads/ThreadHomePage"
import { useIsMobile } from "../hooks/useIsMobile"
import { useMe } from "../hooks/useMe"
import { usePlatformHealth } from "../hooks/usePlatformHealth"
import { useServerReachable } from "../hooks/useServerReachable"
import type { AppShellMode } from "./types"
import { resolveChatVariant } from "./types"
import { useStore } from "../state/store"
import { useLayoutStore } from "../state/layout-store"
import type { AuditEntry, LogEntry, Step, WidgetType } from "../types"
import { getWidgetDefinition, widgetComponent } from "./workspace/widget-definitions"
import { widgetRegistry } from "../widgets"

const SHELL_TRANSITION_MS = 280

function shellTransitionDelay(): number {
  if (typeof window === "undefined") return SHELL_TRANSITION_MS
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : SHELL_TRANSITION_MS
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
  const setPendingToolApproval = useStore((s) => s.setPendingToolApproval)
  const policyEditorOpen = useStore((s) => s.policyEditorOpen)
  const setPolicyEditorOpen = useStore((s) => s.setPolicyEditorOpen)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const canvasRef = useRef<CanvasHandle>(null)
  const isMobile = useIsMobile()
  const [mobileCatalogOpen, setMobileCatalogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [shellMode, setShellMode] = useState<AppShellMode>("chat")
  const [shellVisible, setShellVisible] = useState(true)
  const shellTimerRef = useRef<number | null>(null)
  // Becomes true when the login overlay starts its final fade so the home
  // shell crossfades with it instead of waiting for it to fully disappear.
  const [shellRevealing, setShellRevealing] = useState(false)
  const [chatHomeHeroStage, setChatHomeHeroStage] = useState<"hidden" | "pill" | "copy">("hidden")
  const [chatHomeHeroRevealProgress, setChatHomeHeroRevealProgress] = useState(0)
  const { me, loading: meLoading, refresh: refreshMe, logout } = useMe()
  const { health: platformHealth, refresh: refreshPlatformHealth } = usePlatformHealth(!!me)
  const { reachable: serverReachable } = useServerReachable(true)
  const bootstrapThreads = useStore((s) => s.bootstrapThreads)

  const popOut = getPopOutWidget()
  const currentView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? views[0] ?? null,
    [views, activeViewId],
  )
  const tiles = useMemo(
    () => [...(currentView?.tiles ?? [])].sort((a, b) => a.y - b.y || a.x - b.x),
    [currentView],
  )
  const visibleWidgetTypes = useMemo(() => {
    if (popOut) return new Set<WidgetType>([popOut.type])
    return new Set<WidgetType>((currentView?.tiles ?? []).map((tile) => tile.type))
  }, [currentView, popOut])
  const shouldHydrateSelectedRun = visibleWidgetTypes.has("run-status")
    || visibleWidgetTypes.has("run-history")
    || visibleWidgetTypes.has("step-timeline")
    || visibleWidgetTypes.has("debug-inspector")
    || visibleWidgetTypes.has("term-chat")
    || visibleWidgetTypes.has("agent-chat")
  const shouldRestoreSyncState = visibleWidgetTypes.has("env-sync")
  const shouldHydrateRecentEvents = visibleWidgetTypes.has("live-logs")

  // Phase state machine — v19 simplified.
  //   Loading   — initial whoami fetch in flight; blank screen
  //   Login     — not authenticated; <WelcomeFlow/> renders intro + form
  //   Shell     — authenticated; dashboard visible
  //   Outro     — logout in progress; mosaic covers inward, then logout
  //                  fires and we land back on Login (which plays intro)
  const [phase, setPhase] = useState<AppPhase>(AppPhase.Loading)

  // Decide phase from auth state.
  // a verified user (shell) or we don't (login). No welcome modal, no
  // anon fallback, no "reveal" path because there's no longer a separate
  // identity-collection step that runs after the page mounts.
  useEffect(() => {
    if (popOut) { setPhase(AppPhase.Shell); return }
    if (meLoading) return
    // Don't yank a running animation out from under the user just because
    // `me` updated mid-flight. Outro owns its own exit.
    if (phase === AppPhase.Outro) return
    if (me) {
      // During phase=Login with me set, we're mid-intro — the WelcomeFlow
      // is playing its morph + dissolve over the now-rendered shell. Don't
      // flip to Shell here; let WelcomeFlow.onDone do it once the mosaic
      // has fully dissolved. Otherwise we'd unmount the animation halfway.
      if (phase === AppPhase.Login) return
      setPhase(AppPhase.Shell)
    } else {
      setPhase(AppPhase.Login)
    }
  }, [me, meLoading, popOut, phase])

  const handleSwitchUser = useCallback(() => {
    // Flush any pending debounced layout save before the logout animation
    // starts — otherwise changes made within the 2-second debounce window
    // would be silently dropped when the session ends.
    flushDashboardSave()
    // Cover the shell with the outro animation; the actual logout fires
    // when the animation hits its done frame, so the dashboard stays
    // visible underneath the dissolving mosaic the whole time.
    setPhase(AppPhase.Outro)
  }, [])

  useEffect(() => {
    if (!me?.upn) return
    setShellVisible(true)
    setShellMode("chat")
  }, [me?.upn])

  useEffect(() => () => {
    if (shellTimerRef.current) window.clearTimeout(shellTimerRef.current)
  }, [])

  const transitionShellMode = useCallback((next: AppShellMode) => {
    setShellMode((current) => {
      if (current === next) return current
      setShellVisible(false)
      if (shellTimerRef.current) window.clearTimeout(shellTimerRef.current)
      const delay = shellTransitionDelay()
      shellTimerRef.current = window.setTimeout(() => {
        setShellMode(next)
        requestAnimationFrame(() => setShellVisible(true))
      }, delay)
      return current
    })
  }, [])

  // Reset reveal flag each time we return to login so the next login
  // starts with the chat content hidden. Also clear the shared ASCII
  // start timestamp so IntroAsciiField re-runs its per-cell fade-in
  // from t=0 — otherwise the login page would inherit the chat-home's
  // long-settled timestamp and the field would pop in fully populated.
  useEffect(() => {
    if (phase === AppPhase.Login) {
      setShellRevealing(false)
      setChatHomeHeroStage("hidden")
      setChatHomeHeroRevealProgress(0)
      try { delete (window as { __miaIntroAsciiStartTs?: number }).__miaIntroAsciiStartTs } catch { /* ignore */ }
    }
  }, [phase])

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

  // Load threads + active thread runs on login. Thread-scoped — not global listRuns.
  useEffect(() => {
    if (!me) return
    void bootstrapThreads().catch(() => {})
  }, [me?.upn, bootstrapThreads])

  // Auto-select latest run only when a run-scoped widget is visible and
  // nothing is selected yet.
  useEffect(() => {
    if (!me || !shouldHydrateSelectedRun) return
    if (useStore.getState().activeRunId) return
    const pickLatest = (rows: Array<{ id: string; createdAt: string }>) => {
      if (rows.length === 0) return
      const latest = [...rows].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0]
      if (latest) setActiveRun(latest.id)
    }
    const cached = useStore.getState().runs
    if (cached.length > 0) {
      pickLatest(cached)
      return
    }
    const threadId = useStore.getState().activeThreadId
    if (!threadId) return
    api.listRuns({ threadId }).then((runs) => {
      setRuns(runs)
      if (!useStore.getState().activeRunId) pickLatest(runs)
    }).catch(() => {})
  }, [me?.upn, shouldHydrateSelectedRun, setRuns, setActiveRun])

  // Reload notifications on identity change so each user only sees their own.
  useEffect(() => {
    if (!me) return
    api.listNotifications(50).then((items) => {
      setNotifications(items)
      const pendingNote = items.find((n) => n.type === "approval.required" && !n.read)
        ?? items.find((n) => n.type === "approval.required")
      if (!pendingNote?.runId) return
      const approveAction = pendingNote.actions.find((a) => a.action === "approve-run-step")
      const toolMatch = pendingNote.message.match(/^Tool "([^"]+)"/)
      setPendingToolApproval({
        approvalId: (approveAction?.data?.approvalId as string | undefined) ?? null,
        runId: pendingNote.runId,
        stepId: pendingNote.stepId ?? "",
        toolName: toolMatch?.[1] ?? "unknown",
        reason: pendingNote.message.replace(/^Tool "[^"]+" needs approval: /, "") || pendingNote.message,
        notificationId: pendingNote.id,
      })
      useStore.getState().setApprovalModalOpen(false)
    }).catch(() => {})
    api.listPendingToolApprovals().then((approvals) => {
      const pending = approvals.find((a) => a.status === "pending")
      if (!pending) return
      const state = useStore.getState()
      if (state.pendingToolApproval?.approvalId) return
      setPendingToolApproval({
        approvalId: pending.id,
        runId: pending.runId,
        stepId: pending.stepId,
        toolName: pending.toolName,
        reason: pending.reason,
        policyName: pending.policyName,
        args: pending.args,
        notificationId: state.pendingToolApproval?.notificationId ?? null,
      })
      useStore.getState().setApprovalModalOpen(false)
    }).catch(() => {})
  }, [me?.upn, setNotifications, setPendingToolApproval])

  // Restore the EnvSync widget operator context from the user's most recent
  // manual sync run (env pair + entity type). Plans are hydrated only by
  // explicit preview/history/agent actions — not on widget visibility.
  useEffect(() => {
    if (!me) return
    if (!shouldRestoreSyncState) return
    const current = useStore.getState().envSyncForm
    if (current.source && current.target) return
    api.syncRuns(1).then((rows) => {
      const latest = rows[0]
      if (!latest) return
      if (latest.actorUpn !== me.upn) return
      useStore.getState().setEnvSyncForm({
        source: latest.source,
        target: latest.target,
        entityType: latest.entityType,
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
        if (stashed.trace) setTrace(stashed.trace as import("../types").TraceEntry[])
      } catch { /* ignore corrupt data */ }
    }
    // No API fallback — popout receives live events via BroadcastChannel relay.
    // If no stashed state, the popout starts empty and accumulates from the stream.

    const threadId = useStore.getState().activeThreadId
    if (threadId) {
      api.listRuns({ threadId }).then((runs) => setRuns(runs)).catch(() => {})
    }

    // Sync from main window — receive full live state on activeRunId change
    const sync = new BroadcastChannel(SYNC_CHANNEL)
    sync.onmessage = (e) => {
      const msg = e.data as {
        activeRunId: string
        logs?: LogEntry[]
        steps?: Step[]
        audit?: AuditEntry[]
        trace?: import("../types").TraceEntry[]
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
        onDone={() => {
          setChatHomeHeroRevealProgress(1)
          setPhase(AppPhase.Shell)
        }}
        onFading={() => setShellRevealing(true)}
        onEnteringStart={() => {
          setChatHomeHeroStage("pill")
          setChatHomeHeroRevealProgress(0)
        }}
        onEntered={() => setChatHomeHeroStage("copy")}
        onPillRevealProgress={setChatHomeHeroRevealProgress}
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
  if (phase === AppPhase.Login && !me) {
    return (
      <>
        {welcomeOverlay}
        <div className="h-screen" style={{ background: "var(--bg)" }} />
      </>
    )
  }

  let shellBody: ReactNode

  if (shellMode === "chat") {
    const chatVariant = resolveChatVariant()
    const chatProps = {
      connected: connected && serverReachable,
      isAdmin: me?.isAdmin ?? false,
      me,
      onModeChange: transitionShellMode,
      onSignOut: handleSwitchUser,
      revealed: shellRevealing || phase === AppPhase.Shell,
      heroStage: (phase === AppPhase.Shell ? "copy" : chatHomeHeroStage) as "hidden" | "pill" | "copy",
      heroRevealProgress: phase === AppPhase.Shell ? 1 : chatHomeHeroRevealProgress,
    }
    shellBody = chatVariant === "thread" ? (
      <ThreadHomePage
        {...chatProps}
        morphLanding={phase === AppPhase.Login && !!me}
      />
    ) : (
      <ChatHomePage {...chatProps} />
    )
  } else if (isMobile) {
    shellBody = (
      <div className="flex flex-col h-[100dvh] bg-base">
        {/* Compact header */}
        <header className="flex items-center gap-3 px-4 h-12 bg-surface shrink-0 select-none">
          <div className="shrink-0 min-w-0">
            <span className="text-sm font-semibold text-text tracking-wide">
              MI<span className="text-accent">:A</span>
            </span>
          </div>
          <div className="flex-1 min-w-0 text-center px-2">
            <span className="block max-w-full truncate text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">
              {currentView?.name ?? "Workspace"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${connected && serverReachable ? "bg-success" : "bg-error"}`}
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
                      onClick={() => { transitionShellMode("chat"); setMobileMenuOpen(false) }}
                    >
                      <MessageSquare size={15} /> Chat
                    </button>
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-overlay-2"
                      onClick={() => { transitionShellMode("workspace"); setMobileMenuOpen(false) }}
                    >
                      <LayoutGrid size={15} /> Workspace
                    </button>
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-overlay-2"
                      onClick={() => { setPolicyEditorOpen(true); setMobileMenuOpen(false) }}
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
        <main className="flex-1 overflow-y-auto show-scrollbar">
          {tiles.length === 0 ? (
            <EmptyState
              icon={LayoutGrid}
              message="No widgets in this view yet"
              action={(
                <button
                  type="button"
                  className="px-6 py-3 text-sm text-text-secondary border border-border rounded-xl active:bg-overlay-2"
                  onClick={() => setMobileCatalogOpen(true)}
                >
                  Add Widget
                </button>
              )}
            />
          ) : (
            <div className="flex flex-col gap-3 p-2 pb-4">
              {tiles.map((tile) => {
                const Widget = widgetComponent(tile.type)
                const definition = getWidgetDefinition(tile.type)
                return (
                  <section
                    key={tile.id}
                    className="min-h-[50dvh] bg-surface rounded-xl overflow-hidden flex flex-col"
                  >
                    <div className="px-3 h-8 flex items-center shrink-0 border-b border-border-subtle">
                      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
                        {definition.label}
                      </span>
                    </div>
                    <div className={`flex-1 min-h-0 overflow-hidden ${definition.chrome === "flush" ? "" : "p-3"}`}>
                      <Widget />
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </main>

        {/* Bottom navigation — always visible so the user can switch
            views even when the active view is empty. */}
        <MobileNav
          views={views}
          activeViewId={activeViewId}
          onSelectView={(id) => useLayoutStore.getState().setActiveView(id)}
          onAdd={() => {
            const newId = useLayoutStore.getState().addView(`View ${views.length + 1}`)
            useLayoutStore.getState().setActiveView(newId)
            setMobileCatalogOpen(true)
          }}
        />

        {mobileCatalogOpen && <WidgetCatalog onClose={() => setMobileCatalogOpen(false)} />}
        {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      </div>
    )
  } else {
    shellBody = (
      <div className="flex flex-col h-screen bg-base">
        <Toolbar
          onAddWidget={() => canvasRef.current?.openCatalog()}
          onSignOut={handleSwitchUser}
          onModeChange={transitionShellMode}
          me={me}
        />
        <Canvas ref={canvasRef} />
        <WidgetModal />
      </div>
    )
  }

  return (
    <>
      {welcomeOverlay}
      <ApprovalRequiredModal />
      {policyEditorOpen && !popOut && <PolicyEditor onClose={() => setPolicyEditorOpen(false)} />}
      <div
        className={`app-shell-view flex flex-col h-screen min-h-[100dvh] ${shellVisible ? "" : "app-shell-view--fading"}`}
      >
        {me && (
          <PlatformHealthBanner
            health={platformHealth}
            isAdmin={me.isAdmin}
            onRefresh={refreshPlatformHealth}
          />
        )}
        <div className="flex-1 min-h-0">{shellBody}</div>
      </div>
    </>
  )
}
