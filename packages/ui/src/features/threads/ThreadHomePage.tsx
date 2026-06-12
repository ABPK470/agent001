import { LayoutGrid, LogOut, PanelLeft } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../../api"
import { IntroAsciiField } from "../../components/IntroAsciiField"
import { MiaWordmark } from "../../components/IntroConversation"
import { Logo } from "../../components/Logo"
import { useStore } from "../../store"
import { TermChat } from "../../widgets/TermChat"
import { ThreadSidebar } from "./ThreadSidebar"
import { useThreadRailLayout } from "./useThreadRailLayout"

interface Props {
  connected: boolean
  onOpenPlatform: () => void
  onLogout: () => void
}

export function ThreadHomePage({
  connected,
  onOpenPlatform,
  onLogout,
}: Props): React.ReactElement {
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const collapsed = useStore((s) => s.threadSidebarCollapsed)
  const setThreads = useStore((s) => s.setThreads)
  const selectThread = useStore((s) => s.selectThread)
  const createNewThread = useStore((s) => s.createNewThread)
  const setThreadSidebarCollapsed = useStore((s) => s.setThreadSidebarCollapsed)

  const [threadsDrawerOpen, setThreadsDrawerOpen] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)
  const { viewportWidth, railFits } = useThreadRailLayout()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const listed = await api.listThreads()
        if (cancelled) return
        setThreads(listed)
        const persistedId = useStore.getState().activeThreadId
        const target =
          (persistedId && listed.some((t) => t.id === persistedId) && persistedId) ||
          listed[0]?.id ||
          null
        if (target) {
          await selectThread(target)
        } else {
          await createNewThread()
        }
      } catch {
        if (!cancelled) await createNewThread().catch(() => {})
      } finally {
        if (!cancelled) setBootstrapped(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setThreads, selectThread, createNewThread])

  const handleNewThread = useCallback(async () => {
    await createNewThread()
    setThreadsDrawerOpen(false)
  }, [createNewThread])

  const handleOpenThreads = useCallback(() => {
    if (railFits) {
      setThreadSidebarCollapsed(false)
      return
    }
    setThreadsDrawerOpen(true)
  }, [railFits, setThreadSidebarCollapsed])

  const showHeaderThreadsButton =
    !railFits || viewportWidth < 1024 || (collapsed && viewportWidth < 1280)

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
    if (railFits) setThreadsDrawerOpen(false)
  }, [railFits])

  return (
    <div className="chathome chathome--threads chathome--revealed chathome--hero-ready chathome--hero-copy-ready relative flex h-screen flex-col overflow-hidden text-text">
      <div className="chathome-frame pointer-events-none absolute inset-0 overflow-hidden">
        <IntroAsciiField surface="home" />
      </div>

      <div className="chathome-content relative z-10 flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between px-4 sm:h-14 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Logo size={30} online={connected} />
            <div className="flex shrink-0 items-center gap-2.5 text-text">
              <MiaWordmark />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {showHeaderThreadsButton && (
              <button
                type="button"
                onClick={handleOpenThreads}
                title="Open threads"
                aria-label="Open threads"
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"
              >
                <PanelLeft size={17} strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenPlatform}
              title="Open platform view"
              aria-label="Open platform view"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"
            >
              <LayoutGrid size={17} />
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Log out"
              aria-label="Log out"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:bg-overlay-hover hover:text-text"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        <main className="thread-rail-stage relative flex min-h-0 flex-1">
          <ThreadSidebar
            threads={threads}
            activeThreadId={activeThreadId}
            collapsed={collapsed}
            railFits={railFits}
            onToggleCollapsed={() => setThreadSidebarCollapsed(!collapsed)}
            onSelect={selectThread}
            onNewThread={handleNewThread}
            drawerOpen={threadsDrawerOpen}
            onDrawerClose={() => setThreadsDrawerOpen(false)}
          />

          <div className="thread-rail-chat flex min-h-0 min-w-0 flex-1 flex-col">
            {bootstrapped && activeThreadId && (
              <TermChat key={activeThreadId} mode="thread" threadId={activeThreadId} />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
