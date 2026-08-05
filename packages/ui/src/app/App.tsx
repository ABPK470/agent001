import { Activity, LayoutGrid, MessageSquare, MoreVertical, Shield, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, createEventStream, createPopoutEventRelay } from "../client/index"
import { EmptyState } from "../components/EmptyState"
import { AppPhase } from "../enums"
import { useIsMobile } from "../hooks/useIsMobile"
import { useMe } from "../hooks/useMe"
import { useViewingAs } from "../hooks/useViewingAs"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"
import { getViewingAsUpn, resetViewingAsMemory, syncViewingAsForSession } from "../lib/viewing-as"
import { usePlatformHealth } from "../hooks/usePlatformHealth"
import { useServerReachable } from "../hooks/useServerReachable"
import { useLayoutStore } from "../state/layout-store"
import { useOperationsStore } from "../state/operations-store"
import { useStore } from "../state/store"
import type { AuditEntry, LogEntry, Step, WidgetType } from "../types"
import { widgetRegistry } from "../widgets"
import { ApprovalRequiredModal } from "../widgets/platform/ApprovalRequiredModal"
import { PlatformHealthBanner } from "../widgets/platform/PlatformHealthBanner"
import { PolicyEditor } from "../widgets/platform/PolicyEditor"
import { UsageModal } from "../widgets/platform/UsageModal"
import { ThreadHomePage } from "../widgets/threads/ThreadHomePage"
import { flushDashboardSave, restoreDashboardState, startDashboardSync } from "./dashboard-sync"
import { ChatHomePage } from "./home/ChatHomePage"
import { IntroAsciiField } from "./home/IntroAsciiField"
import { WelcomeFlow } from "./home/WelcomeFlow"
import {
  shellModeTransitionMs,
  shellTrackSlideClass,
} from "./shell-mode-transition"
import type { AppShellMode } from "./types"
import { isOpenWidgetCatalogEvent, isShellModeToggleEvent, resolveChatVariant } from "./types"
import { Canvas, type CanvasHandle } from "./workspace/Canvas"
import { MobileNav } from "./workspace/MobileNav"
import { Toolbar } from "./workspace/Toolbar"
import { getWidgetDefinition, widgetComponent } from "./workspace/widget-definitions"
import { WidgetCatalog } from "./workspace/WidgetCatalog"
import { WidgetModal } from "./workspace/WidgetModal"

const SYNC_CHANNEL = "mia-active-run"

/** Detect ?widget= param for pop-out mode */
function getPopOutWidget(): { type: WidgetType; runId: string | null } | null {
  const params = new URLSearchParams(window.location.search)
  const type = params.get("widget") as WidgetType | null
  if (!type || !(type in widgetRegistry)) return null
  return { type, runId: params.get("runId") }
}

/** Clear Personal client state when Viewing as / session identity changes. */
function clearPersonalClientState(): void {
  const store = useStore.getState()
  store.setActiveThreadId(null)
  store.setActiveRun(null)
  store.setRuns([])
  store.setSteps([])
  store.setLogs([])
  store.setAudit([])
  store.setTrace([])
}

function hydratePersonalNotifications(
  setNotifications: (items: Awaited<ReturnType<typeof api.listNotifications>>) => void,
): void {
  const hydrate = useStore.getState().hydratePendingToolApproval
  api.listNotifications(50).then((items) => {
    setNotifications(items)
    const pendingNote = items.find((n) => n.type === "approval.required" && !n.read)
      ?? items.find((n) => n.type === "approval.required")
    if (!pendingNote?.runId) return
    const approveAction = pendingNote.actions.find((a) => a.action === "approve-run-step")
    const toolMatch = pendingNote.message.match(/^Tool "([^"]+)"/)
    hydrate({
      approvalId: (approveAction?.data?.approvalId as string | undefined) ?? null,
      runId: pendingNote.runId,
      stepId: pendingNote.stepId ?? "",
      toolName: toolMatch?.[1] ?? "unknown",
      reason: pendingNote.message.replace(/^Tool "[^"]+" needs approval: /, "") || pendingNote.message,
      notificationId: pendingNote.id,
    })
  }).catch((err: unknown) => { console.error("[mia]", err) })

  api.listPendingToolApprovals().then((approvals) => {
    const pending = approvals.find((a) => a.status === "pending")
    if (!pending) return
    const state = useStore.getState()
    if (state.pendingToolApproval?.approvalId) return
    hydrate({
      approvalId: pending.id,
      runId: pending.runId,
      stepId: pending.stepId,
      toolName: pending.toolName,
      reason: pending.reason,
      policyName: pending.policyName,
      args: pending.args,
      notificationId: state.pendingToolApproval?.notificationId ?? null,
    })
  }).catch((err: unknown) => { console.error("[mia]", err) })
}

function hydratePersonalLatestRun(
  setRuns: (runs: Awaited<ReturnType<typeof api.listRuns>>) => void,
  setActiveRun: (id: string) => void,
): void {
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
  }).catch((err: unknown) => { console.error("[mia]", err) })
}

/** Env Sync form restore from Personal history (Me only — writes disabled when Viewing as other). */
function restorePersonalEnvSyncForm(): void {
  const current = useStore.getState().envSyncForm
  if (current.source && current.target) return
  api.syncHistory({ page: 1, pageSize: 1, sort: "started_desc" }).then((page) => {
    const latest = page.items[0]
    if (!latest) return
    useStore.getState().setEnvSyncForm({
      source: latest.source,
      target: latest.target,
      entityType: latest.entityType,
    })
  }).catch((err: unknown) => { console.error("[mia]", err) })
}

export function App() {
  const setConnected = useStore((s) => s.setConnected)
  const connected = useStore((s) => s.connected)
  const reconcileLiveRuns = useStore((s) => s.reconcileLiveRuns)
  const refreshOperationsHead = useOperationsStore((s) => s.refreshHeadIfRetained)
  const handleEvent = useStore((s) => s.handleEvent)
  const setRuns = useStore((s) => s.setRuns)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const setSteps = useStore((s) => s.setSteps)
  const setLogs = useStore((s) => s.setLogs)
  const setAudit = useStore((s) => s.setAudit)
  const setTrace = useStore((s) => s.setTrace)
  const setNotifications = useStore((s) => s.setNotifications)
  const policyEditorOpen = useStore((s) => s.policyEditorOpen)
  const setPolicyEditorOpen = useStore((s) => s.setPolicyEditorOpen)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenTileId = useLayoutStore((s) => s.zenTileId)
  const canvasRef = useRef<CanvasHandle>(null)
  const isMobile = useIsMobile()
  const [mobileCatalogOpen, setMobileCatalogOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [shellMode, setShellMode] = useState<AppShellMode>("chat")
  const shellModeRef = useRef<AppShellMode>(shellMode)
  shellModeRef.current = shellMode
  const [shellTrackReady, setShellTrackReady] = useState(false)
  const shellTrackReadyRef = useRef(shellTrackReady)
  shellTrackReadyRef.current = shellTrackReady
  const [shellSliding, setShellSliding] = useState(false)
  const shellSlidingRef = useRef(shellSliding)
  shellSlidingRef.current = shellSliding
  const [slideMode, setSlideMode] = useState<AppShellMode>("chat")
  const shellTransitionTimersRef = useRef<number[]>([])
  const personalScopeRef = useRef<string | null>(null)
  const prevConnectedRef = useRef(false)
  // Becomes true when the login overlay starts its final fade so the home
  // shell crossfades with it instead of waiting for it to fully disappear.
  const [shellRevealing, setShellRevealing] = useState(false)
  const [chatHomeHeroStage, setChatHomeHeroStage] = useState<"hidden" | "pill" | "copy">("hidden")
  const [chatHomeHeroRevealProgress, setChatHomeHeroRevealProgress] = useState(0)
  /** Hold app content a beat after the morph signal so it doesn’t beat the pill. */
  const SHELL_REVEAL_LAG_MS = 0
  const shellRevealTimersRef = useRef<number[]>([])
  function clearShellRevealTimers() {
    for (const id of shellRevealTimersRef.current) window.clearTimeout(id)
    shellRevealTimersRef.current = []
  }
  function lagShellReveal(fn: () => void) {
    const id = window.setTimeout(fn, SHELL_REVEAL_LAG_MS)
    shellRevealTimersRef.current.push(id)
  }
  const { me, loading: meLoading, refresh: refreshMe, logout } = useMe()
  const { viewingAsUpn, isViewingAsOther } = useViewingAs()
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
    || visibleWidgetTypes.has("debug-inspector")
    || visibleWidgetTypes.has("term-chat")
    || visibleWidgetTypes.has("thread-nav")
  const shouldRestoreSyncState = visibleWidgetTypes.has("env-sync")
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
    flushDashboardSave()
    clearShellTransitionTimers()
    setShellSliding(false)
    setPhase(AppPhase.Outro)
  }, [])

  useEffect(() => {
    if (!me?.upn) {
      resetViewingAsMemory()
      return
    }
    clearShellTransitionTimers()
    setShellSliding(false)
    setSlideMode("chat")
    setShellMode("chat")
    syncViewingAsForSession({ upn: me.upn, isAdmin: me.isAdmin })
  }, [me?.upn, me?.isAdmin])

  function clearShellTransitionTimers() {
    for (const id of shellTransitionTimersRef.current) {
      window.clearTimeout(id)
      window.cancelAnimationFrame(id)
    }
    shellTransitionTimersRef.current = []
  }

  useEffect(() => () => clearShellTransitionTimers(), [])

  // Shell body paints as soon as `me` is set (including mid-login intro).
  // The dual-panel track must be ready on that first paint — waiting until
  // phase flips to Shell (~2s after login) remounted chat in a new tree.
  const shellBodyMounted = Boolean(me) && phase !== AppPhase.Loading

  // Desktop: keep the track mounted whenever the shell body is visible
  // (login hand-off, Shell, Outro). Never lazy-mount on phase=Shell alone.
  useEffect(() => {
    if (isMobile || popOut) {
      setShellTrackReady(false)
      return
    }
    if (shellBodyMounted) {
      setShellTrackReady(true)
      return
    }
    setShellTrackReady(false)
  }, [shellBodyMounted, isMobile, popOut])

  const transitionShellMode = useCallback((next: AppShellMode) => {
    if (shellModeRef.current === next) return
    if (shellSlidingRef.current) return
    clearShellTransitionTimers()

    if (isMobile || !shellTrackReadyRef.current || shellModeTransitionMs(next) === 0) {
      setShellSliding(false)
      setSlideMode(next)
      setShellMode(next)
      return
    }

    setShellSliding(true)
    const kickId = window.requestAnimationFrame(() => {
      setSlideMode(next)
    })
    const endId = window.setTimeout(() => {
      setShellMode(next)
      setShellSliding(false)
    }, shellModeTransitionMs(next))
    shellTransitionTimersRef.current.push(kickId, endId)
  }, [isMobile])

  // ⌘⌥ / Ctrl+Alt — toggle chat ↔ workspace from either shell.
  useEffect(() => {
    if (phase !== AppPhase.Shell) return
    function onKeyDown(event: KeyboardEvent) {
      if (!isShellModeToggleEvent(event)) return
      event.preventDefault()
      transitionShellMode(shellModeRef.current === "chat" ? "workspace" : "chat")
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [phase, transitionShellMode])

  // ⌘K / Ctrl+K — open Add-to-layout catalog (workspace only).
  useEffect(() => {
    if (phase !== AppPhase.Shell) return
    function onKeyDown(event: KeyboardEvent) {
      if (!isOpenWidgetCatalogEvent(event)) return
      if (shellModeRef.current !== "workspace") return
      if (isEditableKeyboardTarget(event.target)) return
      event.preventDefault()
      if (isMobile) {
        setMobileCatalogOpen((open) => !open)
        return
      }
      canvasRef.current?.toggleCatalog()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [phase, isMobile])

  // Reset reveal flag each time we return to login so the next login
  // starts with the chat content hidden. Also clear the shared ASCII
  // start timestamp so IntroAsciiField re-runs its per-cell fade-in
  // from t=0 — otherwise the login page would inherit the chat-home's
  // long-settled timestamp and the field would pop in fully populated.
  useEffect(() => {
    if (phase === AppPhase.Login) {
      clearShellRevealTimers()
      setShellRevealing(false)
      setChatHomeHeroStage("hidden")
      setChatHomeHeroRevealProgress(0)
      try { delete (window as { __miaIntroAsciiStartTs?: number }).__miaIntroAsciiStartTs } catch (err: unknown) { console.error("[mia]", err) }
    }
  }, [phase])

  // Personal scope transition — one clear + rehydrate when Me / Viewing as changes.
  // Read scope from the store (not only the hook snapshot) so admin Viewing-as
  // restore in the prior effect does not bootstrap twice on login.
  useEffect(() => {
    if (!me?.upn) {
      personalScopeRef.current = null
      return
    }
    const scopeKey = `${me.upn}:${getViewingAsUpn() ?? ""}`
    if (personalScopeRef.current === scopeKey) return
    personalScopeRef.current = scopeKey
    clearPersonalClientState()
    void bootstrapThreads().catch((err: unknown) => { console.error("[mia]", err) })
    hydratePersonalNotifications(setNotifications)
  }, [me?.upn, viewingAsUpn, bootstrapThreads, setNotifications])

  // SSE transport rekeys with Personal scope (EventSource stamps Viewing as at open).
  useEffect(() => {
    const stream = popOut
      ? createPopoutEventRelay(handleEvent, setConnected)
      : createEventStream(handleEvent, setConnected)
    return () => stream.close()
  }, [handleEvent, setConnected, popOut, me?.upn, viewingAsUpn])

  // After reconnect, reconcile runs that may have terminated while offline.
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      reconcileLiveRuns()
      refreshOperationsHead()
    }
    prevConnectedRef.current = connected
  }, [connected, reconcileLiveRuns, refreshOperationsHead])

  // Widget-gated Personal followers (same scope key; do not re-clear).
  useEffect(() => {
    if (!me || !shouldHydrateSelectedRun) return
    hydratePersonalLatestRun(setRuns, setActiveRun)
  }, [me?.upn, viewingAsUpn, shouldHydrateSelectedRun, setRuns, setActiveRun])

  useEffect(() => {
    if (!me || !shouldRestoreSyncState || isViewingAsOther) return
    restorePersonalEnvSyncForm()
  }, [me?.upn, viewingAsUpn, isViewingAsOther, shouldRestoreSyncState])

  // Event Stream (live-logs) loads its own history via useEventStreamData —
  // no App-level hydrate. Live rows still arrive through SSE → store.addLog.

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
      } catch (err: unknown) { console.error("[mia]", err) }
    }
    // No API fallback — popout receives live events via BroadcastChannel relay.
    // If no stashed state, the popout starts empty and accumulates from the stream.

    const threadId = useStore.getState().activeThreadId
    if (threadId) {
      api.listRuns({ threadId }).then((runs) => setRuns(runs)).catch((err: unknown) => { console.error("[mia]", err) })
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
        signal:      AbortSignal.timeout(60_000),
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
        onFading={() => lagShellReveal(() => setShellRevealing(true))}
        onEnteringStart={() => {
          setChatHomeHeroStage("pill")
          setChatHomeHeroRevealProgress(0)
        }}
        onEntered={() => lagShellReveal(() => setChatHomeHeroStage("copy"))}
        onPillRevealProgress={(progress) => {
          lagShellReveal(() => setChatHomeHeroRevealProgress(progress))
        }}
      />
    ) : phase === AppPhase.Outro ? (
      <WelcomeFlow
        key="outro"
        mode="outro"
        onSubmit={async () => {}}
        onDone={async () => {
          try { await logout() } catch (err: unknown) { console.error("[mia]", err) }
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

  function renderShellBody(mode: AppShellMode, opts?: { canvasActive?: boolean }): ReactNode {
  if (mode === "chat") {
    const chatVariant = resolveChatVariant()
    const chatProps = {
      connected: connected && serverReachable,
      me,
      onModeChange: transitionShellMode,
      onSignOut: handleSwitchUser,
      revealed: shellRevealing || phase === AppPhase.Shell || phase === AppPhase.Outro,
      heroStage: (phase === AppPhase.Shell || phase === AppPhase.Outro
        ? "copy"
        : chatHomeHeroStage) as "hidden" | "pill" | "copy",
      heroRevealProgress: phase === AppPhase.Shell || phase === AppPhase.Outro ? 1 : chatHomeHeroRevealProgress,
    }
    return chatVariant === "thread" ? (
      <ThreadHomePage
        {...chatProps}
        morphLanding={phase === AppPhase.Login && !!me && chatHomeHeroStage !== "copy"}
      />
    ) : (
      <ChatHomePage {...chatProps} />
    )
  }

  if (isMobile) {
    return (
      <div className="flex flex-col h-[100dvh] bg-base">
        {/* Compact header */}
        <header className="relative z-20 flex h-12 shrink-0 select-none items-center gap-3 bg-surface px-4">
          <div className="shrink-0 min-w-0">
            <span className="text-sm font-semibold text-text tracking-wide">
              MI<span className="text-accent">:A</span>
            </span>
          </div>
          <div className="flex-1 min-w-0 text-center px-2">
            <span className="block max-w-full truncate text-[13px] font-medium text-text-muted tracking-normal whitespace-nowrap">
              {currentView?.name ?? "Workspace"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${
                connected && serverReachable
                  ? "border-[1.5px] border-text bg-transparent"
                  : "bg-text"
              }`}
              title={connected && serverReachable ? "Connected" : "Disconnected"}
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
                    {me?.isAdmin && (
                    <button
                      className="flex items-center gap-2.5 w-full px-4 py-3 text-sm text-text-secondary active:bg-overlay-2"
                      onClick={() => { setPolicyEditorOpen(true); setMobileMenuOpen(false) }}
                    >
                      <Shield size={15} /> Policies
                    </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Widget area — full remaining space */}
        <main className="relative flex-1 overflow-y-auto show-scrollbar">
          {isViewingAsOther && !soloTileId && (
            <div className="workspace-stage-glyphs pointer-events-none overflow-hidden" aria-hidden>
              <IntroAsciiField surface="home" viewingAsField />
            </div>
          )}
          <div className="relative">
            {tiles.length === 0 ? (
              <EmptyState
                icon={LayoutGrid}
                message="This layout is empty"
                action={(
                  <button
                    type="button"
                    className="px-6 py-3 text-sm text-text-secondary border border-border rounded-xl active:bg-overlay-2"
                    onClick={() => setMobileCatalogOpen(true)}
                  >
                    Add to layout
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
                        <span className="text-xs font-medium text-text-muted tracking-normal">
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
          </div>
        </main>

        {/* Bottom navigation — always visible so the user can switch
            views even when the active view is empty. */}
        <MobileNav
          views={views}
          activeViewId={activeViewId}
          onSelectView={(id) => useLayoutStore.getState().setActiveView(id)}
          onAdd={() => {
            const id = useLayoutStore.getState().addView("")
            const short = id.slice(0, 4)
            useLayoutStore.getState().renameView(id, `Layout ${short}`)
            setMobileCatalogOpen(true)
          }}
        />

        {mobileCatalogOpen && <WidgetCatalog onClose={() => setMobileCatalogOpen(false)} />}
        {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
      </div>
    )
  }

  return (
    <div
      className={[
        "workspace-chrome flex h-full min-h-0 flex-col",
        zenTileId ? "workspace-chrome--zen" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="workspace-sheet flex min-h-0 flex-1 flex-col">
        <Toolbar
          onAddWidget={() => canvasRef.current?.openCatalog()}
          onSignOut={handleSwitchUser}
          onModeChange={transitionShellMode}
          me={me}
        />
        <div className="workspace-stage relative flex min-h-0 flex-1 flex-col">
          <Canvas ref={(opts?.canvasActive ?? true) ? canvasRef : undefined} />
        </div>
      </div>
      <WidgetModal />
    </div>
  )
  }

  function shellPanelInactive(mode: AppShellMode): boolean {
    return shellTrackReady && !shellSliding && shellMode !== mode
  }

  function shellCanvasActive(mode: AppShellMode): boolean {
    const shellLive = phase === AppPhase.Shell || phase === AppPhase.Outro
    return shellLive && shellMode === mode && !shellSliding
  }

  return (
    <>
      {welcomeOverlay}
      <ApprovalRequiredModal />
      {policyEditorOpen && !popOut && <PolicyEditor onClose={() => setPolicyEditorOpen(false)} />}
      <div
        className={[
          "app-shell-view flex flex-col h-screen min-h-[100dvh]",
          phase === AppPhase.Outro ? "app-shell-view--outro" : "",
          shellSliding ? "app-shell-view--sliding" : "",
          shellMode === "chat" ? "app-shell-view--chat" : "app-shell-view--workspace",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {me && (
          <PlatformHealthBanner
            health={platformHealth}
            isAdmin={me.isAdmin}
            onRefresh={refreshPlatformHealth}
          />
        )}
        <div className="app-shell-track relative z-[1] min-h-0 flex-1">
          {shellTrackReady ? (
            <div
              className={[
                "app-shell-slider",
                shellTrackSlideClass(slideMode),
                shellSliding ? "app-shell-slider--sliding" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div
                className={[
                  "app-shell-panel app-shell-panel--workspace",
                  shellPanelInactive("workspace") ? "app-shell-panel--inactive" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden={shellPanelInactive("workspace")}
              >
                {renderShellBody("workspace", { canvasActive: shellCanvasActive("workspace") })}
              </div>
              <div
                className={[
                  "app-shell-panel app-shell-panel--chat",
                  shellPanelInactive("chat") ? "app-shell-panel--inactive" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden={shellPanelInactive("chat")}
              >
                {renderShellBody("chat", { canvasActive: shellCanvasActive("chat") })}
              </div>
            </div>
          ) : (
            <div className="app-shell-panel">
              {renderShellBody(shellMode)}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
