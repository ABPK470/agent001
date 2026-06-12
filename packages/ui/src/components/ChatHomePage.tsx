import { LayoutGrid, LogOut } from "lucide-react"
import { useEffect, useState } from "react"
import { useStore } from "../store"
import { TermChat } from "../widgets/TermChat"
import { IntroAsciiField } from "./IntroAsciiField"
import { MiaWordmark } from "./IntroConversation"
import { Logo } from "./Logo"

interface Props {
  connected: boolean
  onOpenPlatform: () => void
  onLogout: () => void
  revealed?: boolean
  heroStage?: "hidden" | "pill" | "copy"
  heroRevealProgress?: number
}

export function ChatHomePage({
  connected,
  onOpenPlatform,
  onLogout,
  revealed = true,
  heroStage,
  heroRevealProgress = 1,
}: Props) {
  const [materialised, setMaterialised] = useState(revealed)
  const bootstrapThreads = useStore((s) => s.bootstrapThreads)

  useEffect(() => {
    if (revealed && !materialised) setMaterialised(true)
  }, [revealed, materialised])

  useEffect(() => {
    void bootstrapThreads().catch(() => {})
  }, [bootstrapThreads])

  const resolvedHeroStage = heroStage ?? (revealed ? "copy" : "hidden")

  const stateClass = `${materialised ? "chathome--revealed" : "chathome--veiled"}${resolvedHeroStage !== "hidden" ? " chathome--hero-ready" : ""}${resolvedHeroStage === "pill" ? " chathome--hero-pill" : ""}${resolvedHeroStage === "copy" ? " chathome--hero-copy-ready" : ""}`

  return (
      <div
          className={`chathome ${stateClass} relative flex h-screen flex-col overflow-hidden text-text`}
      >
          <div className="chathome-frame pointer-events-none absolute inset-0 overflow-hidden">
              <IntroAsciiField surface="home" />
          </div>

          <div className="chathome-content relative z-10 flex h-full min-h-0 flex-col">
              <header className="flex h-12 shrink-0 items-center justify-between px-4 sm:h-14 sm:px-6">
                  <div className="flex min-w-0 items-center gap-3">
                      <Logo size={30} online={connected} />
                      <div className="flex min-w-0 items-center gap-2.5 text-text">
                          <MiaWordmark />
                      </div>
                  </div>

                  <div className="flex items-center gap-2">
                      <button
                          type="button"
                          onClick={onOpenPlatform}
                          title="Open platform view"
                          aria-label="Open platform view"
                          className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:border-border hover:bg-overlay-hover hover:text-text"
                      >
                          <LayoutGrid size={17} />
                      </button>
                      <button
                          type="button"
                          onClick={onLogout}
                          title="Log out"
                          aria-label="Log out"
                          className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel/72 text-text-muted backdrop-blur transition-colors hover:border-border hover:bg-overlay-hover hover:text-text"
                      >
                          <LogOut size={16} />
                      </button>
                  </div>
              </header>

              <main className="flex min-h-0 flex-1 flex-col">
                  <TermChat
                      mode="home"
                      heroRevealProgress={heroRevealProgress}
                  />
              </main>
          </div>
      </div>
  );
}
