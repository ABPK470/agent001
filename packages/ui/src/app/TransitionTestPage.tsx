import { useState } from "react"
import { ChatHomePage } from "./home/ChatHomePage"
import { IntroConversation, type IntroMorphTarget } from "./home/IntroConversation"

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function TransitionTestPage() {
  const [runKey, setRunKey] = useState(0)
  const [phase, setPhase] = useState<"intro" | "layered" | "fading" | "done">("intro")
  const [heroStage, setHeroStage] = useState<"hidden" | "pill" | "copy">("hidden")
  const [heroRevealProgress, setHeroRevealProgress] = useState(0)
  const [enterTrigger, setEnterTrigger] = useState(false)
  const [morphTarget, setMorphTarget] = useState<IntroMorphTarget | undefined>(undefined)
  const shellRevealing = phase === "layered" || phase === "fading" || phase === "done"

  function reset() {
    setRunKey((value) => value + 1)
    setPhase("intro")
    setHeroStage("hidden")
    setHeroRevealProgress(0)
    setEnterTrigger(false)
    setMorphTarget(undefined)
    try { delete (window as { __miaIntroAsciiStartTs?: number }).__miaIntroAsciiStartTs } catch { /* ignore */ }
  }

  function measureAndTrigger() {
    setPhase("layered")
    setHeroStage("pill")
    setHeroRevealProgress(0)
    let attempts = 0
    const tryMeasure = () => {
      attempts++
      const el = document.querySelector<HTMLElement>(
        '.chathome [data-intro-target="termchat-input"]'
      )
      const r = el?.getBoundingClientRect()
      if (r && r.width > 0 && r.height > 0) {
        setMorphTarget({ left: r.left, top: r.top, width: r.width, height: r.height })
        requestAnimationFrame(() => setEnterTrigger(true))
        return
      }
      if (attempts < 30) {
        requestAnimationFrame(tryMeasure)
      } else {
        setEnterTrigger(true)
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(tryMeasure))
  }

  return (
    <div className="relative h-screen overflow-hidden bg-canvas text-text">
      <ChatHomePage
        key={`shell-${runKey}`}
        revealed={shellRevealing}
        heroStage={heroStage}
        heroRevealProgress={phase === "done" ? 1 : heroRevealProgress}
        connected={true}
        onModeChange={() => {}}
        onSignOut={() => reset()}
      />

      {phase !== "done" ? (
        <div
          className={`intro3-route-overlay${phase === "fading" ? " intro3-route-overlay--fading" : ""}`}
          style={{ position: "absolute", inset: 0, zIndex: 20 }}
          onTransitionEnd={(e) => {
            if (phase === "fading" && e.propertyName === "opacity") {
              setHeroRevealProgress(1)
              setHeroStage("copy")
              setPhase("done")
            }
          }}
        >
          <IntroConversation
            key={runKey}
            autoplay={{ username: "test-user", password: "test-pass", stepDelayMs: 360 }}
            onLogin={async () => { await wait(180) }}
            morphMode="chat"
            morphTarget={morphTarget}
            enterTrigger={enterTrigger}
            onEnteringStart={() => {
              setHeroStage("pill")
              setHeroRevealProgress(0)
            }}
            onPillRevealProgress={setHeroRevealProgress}
            onLoginSuccess={() => measureAndTrigger()}
            onEntered={() => setPhase("fading")}
          />
        </div>
      ) : null}

      <div className="absolute right-4 top-4 z-30 flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-full border border-border-subtle bg-panel/80 px-4 py-2 text-sm text-text backdrop-blur transition-colors hover:border-border hover:bg-overlay-hover"
        >
          Replay transition
        </button>
      </div>
    </div>
  )
}
