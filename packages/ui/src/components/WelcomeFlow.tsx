/**
 * WelcomeFlow — primary login surface for the `ui` package.
 *
 * mode="intro" renders the conversational login experience and
 * reproduces the same 3-phase hand-off as the old standalone intro route:
 *   1. intro    — overlay covers; user converses to authenticate
 *   2. layered  — App shell is already painted underneath (App.tsx
 *                 falls through to the real shell as soon as `me` is set);
 *                 we measure the platform's TermChat input rect, choose
 *                 one of three morph "setups" (empty | chat | nochat),
 *                 and animate the intro input bar to that landing rect
 *   3. fading   — overlay cross-fades to 0 over the painted shell
 *                 (.intro3-route-overlay--fading), then onDone() flips
 *                 App to Shell phase
 *
 * mode="outro" / "reveal" / "switching" still use the original mosaic
 * (`WelcomeFlowLegacy`) so the logout, shell-switch and cross-shell
 * reveal flows are preserved untouched.
 *
 * Contract is unchanged for callers: same `WelcomeFlowProps`
 * (`onSubmit`, `onDone`, `mode`) so `App.tsx` doesn't need to
 * special-case which underlying implementation is mounted.
 */
import { useState } from "react"
import {
    WelcomeFlowLegacy,
    type WelcomeFlowLegacyProps,
} from "../../../ui-term/src/components/WelcomeFlowLegacy"
import { useStore } from "../store"
import {
    IntroConversation,
    type IntroMorphMode,
    type IntroMorphTarget,
} from "./IntroConversation"

export type WelcomeFlowProps = WelcomeFlowLegacyProps & {
  /** Called when the intro begins its local enter morph.
   *  Use this to kick off shell-local pill emergence at the same moment
   *  the overlay starts transforming, rather than waiting for the wrapper fade. */
  onEnteringStart?: () => void
  /** Called on each intro morph frame with the renderer-owned local
   *  pill formation progress so the shell reveal can follow the same
   *  signal instead of a separate CSS timeline. */
  onPillRevealProgress?: (progress: number) => void
  /** Called when the login overlay begins its final opacity fade-out.
   *  Use this to start revealing the underlying shell content so the two
   *  cross-fade rather than sequencing with a blank canvas gap. */
  onFading?: () => void
  /** Called once the intro has completed its local morph and starts the
   *  wrapper fade. Use this to synchronize shell-local reveal steps to the
   *  actual overlay handoff instead of guessed timers. */
  onEntered?: () => void
}
export { WelcomeFlowLegacy }

export function WelcomeFlow(props: WelcomeFlowProps) {
  const {
    mode = "intro",
    onSubmit,
    onDone,
    onEnteringStart,
    onPillRevealProgress,
    onFading,
    onEntered,
  } = props

  // Non-intro modes (outro / reveal / switching) still play the legacy
  // mosaic animation — IntroConversation is purely an entry flow.
  if (mode !== "intro") {
    return <WelcomeFlowLegacy {...props} />
  }

  return (
    <IntroConversationLoginAdapter
      onSubmit={onSubmit}
      onDone={onDone}
      onEnteringStart={onEnteringStart}
      onPillRevealProgress={onPillRevealProgress}
      onFading={onFading}
      onEntered={onEntered}
    />
  )
}

/**
 * Bridges `IntroConversation`'s richer hand-off (onLoginSuccess →
 * measure → enterTrigger → onEntered → cross-fade) to `WelcomeFlowProps`'s
 * simpler `onSubmit` / `onDone` contract.
 *
 * This preserves the same 3-phase orchestration the old standalone
 * intro route used. The structural difference: here we do NOT mount
 * <App/> ourselves because
 * App.tsx is already rendering us as a `welcomeOverlay` *over* its own
 * shell body. As soon as `loginOrRegister`'s `refreshMe()` resolves,
 * App's body falls through from the blank `phase === Login && !me`
 * branch into the real shell — which is exactly the "layered" phase.
 */
function IntroConversationLoginAdapter({
  onSubmit,
  onDone,
  onEnteringStart,
  onPillRevealProgress,
  onFading,
  onEntered,
}: {
  onSubmit:  WelcomeFlowProps["onSubmit"]
  onDone:    WelcomeFlowProps["onDone"]
  onEnteringStart?: WelcomeFlowProps["onEnteringStart"]
  onPillRevealProgress?: WelcomeFlowProps["onPillRevealProgress"]
  onFading?: WelcomeFlowProps["onFading"]
  onEntered?: WelcomeFlowProps["onEntered"]
}) {
  const [phase, setPhase] =
    useState<"intro" | "layered" | "fading">("intro")
  const [enterTrigger, setEnterTrigger] = useState(false)
  const [morphMode,   setMorphMode]     = useState<IntroMorphMode>("chat")
  const [morphTarget, setMorphTarget]   =
    useState<IntroMorphTarget | undefined>(undefined)

  // Decide empty-vs-chat morph from the active thread's runs once the shell
  // has bootstrapped — not from stale global state at login time.
  function detectMode(): IntroMorphMode {
    try {
      const s = useStore.getState()
      const threadId = s.activeThreadId
      const scoped = threadId
        ? s.runs.filter((r) => r.threadId === threadId)
        : s.runs
      return scoped.length === 0 ? "empty" : "chat"
    } catch {
      return "chat"
    }
  }

  // After login succeeds, fire onFading (which mounts the shell under
  // the overlay), then poll until thread bootstrap paints the real input
  // pill — empty hero or bottom chat bar — before starting the morph.
  function measureAndTrigger() {
    onFading?.()  // shell reveal starts NOW
    let attempts = 0
    const maxAttempts = 180
    const tryMeasure = () => {
      attempts++
      const el = document.querySelector<HTMLElement>(
        '[data-intro-target="termchat-input"]'
      )
      const r = el?.getBoundingClientRect()
      if (r && r.width > 0 && r.height > 0) {
        setMorphMode(detectMode())
        setMorphTarget({
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
        })
        // Give one frame for the rootStyle CSS vars + AsciiConverge
        // to mount before flipping enterTrigger.
        requestAnimationFrame(() => setEnterTrigger(true))
        return
      }
      if (attempts < maxAttempts) {
        requestAnimationFrame(tryMeasure)
      } else {
        // Last resort — fire anyway so we don't hang the flow.
        setMorphMode(detectMode())
        setEnterTrigger(true)
      }
    }
    requestAnimationFrame(tryMeasure)
  }

  return (
    <div
      className={`intro3-route-overlay${phase === "fading" ? " intro3-route-overlay--fading" : ""}`}
      style={{ position: "absolute", inset: 0, zIndex: 1 }}
      onTransitionEnd={(e) => {
        // Cross-fade complete → hand control back to App so it can flip
        // to Shell phase and unmount this overlay.
        if (phase === "fading" && e.propertyName === "opacity") {
          void onDone()
        }
      }}
    >
      <IntroConversation
        onLogin={onSubmit}
        morphMode={morphMode}
        morphTarget={morphTarget}
        enterTrigger={enterTrigger}
        onEnteringStart={onEnteringStart}
        onPillRevealProgress={onPillRevealProgress}
        onLoginSuccess={() => {
          setPhase("layered")
          measureAndTrigger()
        }}
        onEntered={() => {
          // Login content has gone — start the overlay wrapper fade.
          // onFading already fired at entering start so the chat-home
          // is already well into its own fade by now.
          onEntered?.()
          setPhase("fading")
        }}
      />
    </div>
  )
}


