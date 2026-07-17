import { PanelLeft } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { IntroAsciiField } from "../../components/IntroAsciiField"
import { useStore } from "../../store"
import { TermChat } from "../../widgets/TermChat"
import { ChatBrand } from "../../shell/ChatBrand"
import { ChatChromeButton } from "../../shell/ChatChrome"
import { ChatShellActions } from "../../shell/ChatShellActions"
import type { Me } from "../../hooks/useMe"
import type { AppShellMode } from "../../shell/types"
import { ThreadRailCollapseButton, ThreadRailNewButton, ThreadSidebar } from "./ThreadSidebar"
import { useThreadRailLayout } from "./useThreadRailLayout"

interface Props {
  connected: boolean
  isAdmin?: boolean
  me?: Me | null
  onModeChange: (mode: AppShellMode) => void
  onSignOut: () => void
  onSwitchUi?: () => void
  morphLanding?: boolean
  revealed?: boolean
  heroStage?: "hidden" | "pill" | "copy"
  heroRevealProgress?: number
}

export function ThreadHomePage({
  connected,
  isAdmin = false,
  me,
  onModeChange,
  onSignOut,
  onSwitchUi,
  morphLanding = false,
  revealed = true,
  heroStage,
  heroRevealProgress = 1,
}: Props): React.ReactElement {
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const collapsed = useStore((s) => s.threadSidebarCollapsed)
  const selectThread = useStore((s) => s.selectThread)
  const createNewThread = useStore((s) => s.createNewThread)
  const beginThreadTitleShell = useStore((s) => s.beginThreadTitleShell)
  const setThreadSidebarCollapsed = useStore((s) => s.setThreadSidebarCollapsed)

  const [threadsDrawerOpen, setThreadsDrawerOpen] = useState(false)
  const [landingHandoff, setLandingHandoff] = useState(morphLanding)
  const [chromeRevealed, setChromeRevealed] = useState(() => !morphLanding)
  const [materialised, setMaterialised] = useState(revealed)
  const { viewportWidth, railFits } = useThreadRailLayout()
  const overlayRailEnabled = railFits && viewportWidth >= 1280
  const preferThreadsModal = !overlayRailEnabled

  useEffect(() => {
    if (revealed && !materialised) setMaterialised(true)
  }, [revealed, materialised])

  useEffect(() => {
    if (morphLanding) {
      setLandingHandoff(true)
      setChromeRevealed(false)
    }
  }, [morphLanding])

  useEffect(() => {
    if (morphLanding || !landingHandoff || chromeRevealed) return
    const frame = requestAnimationFrame(() => setChromeRevealed(true))
    return () => cancelAnimationFrame(frame)
  }, [morphLanding, landingHandoff, chromeRevealed])

  useEffect(() => {
    if (chromeRevealed && landingHandoff) setLandingHandoff(false)
  }, [chromeRevealed, landingHandoff])

  const resolvedHeroStage = heroStage ?? (revealed ? "copy" : "hidden")
  const stateClass = `${materialised ? "chathome--revealed" : "chathome--veiled"}${resolvedHeroStage !== "hidden" ? " chathome--hero-ready" : ""}${resolvedHeroStage === "pill" ? " chathome--hero-pill" : ""}${resolvedHeroStage === "copy" ? " chathome--hero-copy-ready" : ""}`

  const handleOpenThreads = useCallback(() => {
    setThreadSidebarCollapsed(false)
    if (preferThreadsModal) setThreadsDrawerOpen(true)
  }, [preferThreadsModal, setThreadSidebarCollapsed])

  const threadsPanelOpenNonce = useStore((s) => s.threadsPanelOpenNonce)
  useEffect(() => {
    if (threadsPanelOpenNonce > 0) handleOpenThreads()
  }, [threadsPanelOpenNonce, handleOpenThreads])

  const handleNewThread = useCallback(async () => {
    const sidebarExpanded = (!collapsed && railFits) || threadsDrawerOpen
    const id = await createNewThread()
    if (sidebarExpanded) beginThreadTitleShell(id)
    setThreadsDrawerOpen(false)
  }, [createNewThread, beginThreadTitleShell, collapsed, railFits, threadsDrawerOpen])

  const railOpen = overlayRailEnabled && !collapsed
  const showHeaderBrand = collapsed || preferThreadsModal
  const showHeaderThreadsButton = preferThreadsModal

  useEffect(() => {
    if (!threadsDrawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThreadsDrawerOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [threadsDrawerOpen])

  useEffect(() => {
    if (!threadsDrawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [threadsDrawerOpen])

  useEffect(() => {
    if (overlayRailEnabled) setThreadsDrawerOpen(false)
  }, [overlayRailEnabled])

  const shellRailClass = [
    "chathome-thread-shell",
    railOpen ? "chathome-thread-shell--rail-open" : "chathome-thread-shell--rail-collapsed",
    !overlayRailEnabled ? "chathome-thread-shell--rail-offstage" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div
      className={`chathome chathome--threads ${chromeRevealed ? "chathome--chrome-revealed" : ""} ${stateClass} relative flex h-screen flex-col overflow-hidden text-text`}
    >
      <div className="chathome-frame pointer-events-none absolute inset-0 overflow-hidden">
        <IntroAsciiField surface="home" adminAccentCorner={isAdmin} />
      </div>

      <div className="chathome-content relative z-10 flex h-full min-h-0 flex-col">
        <div className={shellRailClass}>
          <header className="chathome-thread-chrome relative flex h-12 shrink-0 items-center gap-3 px-4 sm:h-14 sm:px-6">
            <div className="chathome-thread-chrome-rail flex min-w-0 items-center gap-1">
              {showHeaderBrand ? (
                <ChatBrand connected={connected} />
              ) : (
                <>
                  <ChatBrand connected={connected} className="min-w-0 flex-1" />
                  <div className="thread-rail-chrome-actions flex shrink-0 items-center">
                    <ThreadRailNewButton onClick={() => void handleNewThread()} />
                    <ThreadRailCollapseButton
                      onClick={() => setThreadSidebarCollapsed(true)}
                      title="Hide threads"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="min-w-0 flex-1" />

            <div className="flex shrink-0 items-center gap-2">
              {showHeaderThreadsButton && (
                <ChatChromeButton
                  onClick={handleOpenThreads}
                  title="Threads"
                  aria-label="Threads"
                  className="chathome-threads-header-btn"
                >
                  <PanelLeft size={17} strokeWidth={1.75} />
                </ChatChromeButton>
              )}
              <ChatShellActions
                me={me}
                onModeChange={onModeChange}
                onSignOut={onSignOut}
                onSwitchUi={onSwitchUi}
              />
            </div>
          </header>

          <div className="chathome-thread-body thread-rail-stage min-h-0">
            <ThreadSidebar
              threads={threads}
              activeThreadId={activeThreadId}
              collapsed={collapsed}
              railFits={railFits}
              overlayRailEnabled={overlayRailEnabled}
              onToggleCollapsed={() => setThreadSidebarCollapsed(!collapsed)}
              onSelect={selectThread}
              onNewThread={handleNewThread}
              drawerOpen={threadsDrawerOpen}
              onDrawerClose={() => setThreadsDrawerOpen(false)}
            />

            <div className="thread-rail-chat">
              {activeThreadId && (
                <TermChat
                  mode="thread"
                  threadId={activeThreadId}
                  heroRevealProgress={heroRevealProgress}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
