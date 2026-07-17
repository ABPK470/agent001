import { useEffect, useState } from "react"
import type { Me } from "../../hooks/useMe"
import { ChatBrand } from "../ChatBrand"
import { ChatShellActions } from "../ChatShellActions"
import type { AppShellMode } from "../types"
import { TermChat } from "../../widgets/TermChat"
import { IntroAsciiField } from "./IntroAsciiField"

interface Props {
  connected: boolean
  isAdmin?: boolean
  me?: Me | null
  onModeChange: (mode: AppShellMode) => void
  onSignOut: () => void
  revealed?: boolean
  heroStage?: "hidden" | "pill" | "copy"
  heroRevealProgress?: number
}

export function ChatHomePage({
  connected,
  isAdmin = false,
  me,
  onModeChange,
  onSignOut,
  revealed = true,
  heroStage,
  heroRevealProgress = 1,
}: Props) {
  const [materialised, setMaterialised] = useState(revealed)

  useEffect(() => {
    if (revealed && !materialised) setMaterialised(true)
  }, [revealed, materialised])

  const resolvedHeroStage = heroStage ?? (revealed ? "copy" : "hidden")
  const stateClass = `${materialised ? "chathome--revealed" : "chathome--veiled"}${resolvedHeroStage !== "hidden" ? " chathome--hero-ready" : ""}${resolvedHeroStage === "pill" ? " chathome--hero-pill" : ""}${resolvedHeroStage === "copy" ? " chathome--hero-copy-ready" : ""}`

  return (
    <div className={`chathome ${stateClass} relative flex h-screen flex-col overflow-hidden text-text`}>
      <div className="chathome-frame pointer-events-none absolute inset-0 overflow-hidden">
        <IntroAsciiField surface="home" adminAccentCorner={isAdmin} />
      </div>

      <div className="chathome-content relative z-10 flex h-full min-h-0 flex-col">
        <header className="relative flex h-12 shrink-0 items-center justify-between px-4 sm:h-14 sm:px-6">
          <ChatBrand connected={connected} />
          <ChatShellActions
            me={me}
            onModeChange={onModeChange}
            onSignOut={onSignOut}
          />
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TermChat mode="home" heroRevealProgress={heroRevealProgress} />
        </main>
      </div>
    </div>
  )
}
