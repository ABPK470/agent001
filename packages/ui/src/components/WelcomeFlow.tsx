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
  /** Called when the login overlay begins its final opacity fade-out.
   *  Use this to start revealing the underlying shell content so the two
   *  cross-fade rather than sequencing with a blank canvas gap. */
  onFading?: () => void
}
export { WelcomeFlowLegacy }

export function WelcomeFlow(props: WelcomeFlowProps) {
  const { mode = "intro", onSubmit, onDone, onFading } = props

  // Non-intro modes (outro / reveal / switching) still play the legacy
  // mosaic animation — IntroConversation is purely an entry flow.
  if (mode !== "intro") {
    return <WelcomeFlowLegacy {...props} />
  }

  return <IntroConversationLoginAdapter onSubmit={onSubmit} onDone={onDone} onFading={onFading} />
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
  onFading,
}: {
  onSubmit:  WelcomeFlowProps["onSubmit"]
  onDone:    WelcomeFlowProps["onDone"]
  onFading?: WelcomeFlowProps["onFading"]
}) {
  const [phase, setPhase] =
    useState<"intro" | "layered" | "fading">("intro")
  const [enterTrigger, setEnterTrigger] = useState(false)
  const [morphMode,   setMorphMode]     = useState<IntroMorphMode>("chat")
  const [morphTarget, setMorphTarget]   =
    useState<IntroMorphTarget | undefined>(undefined)

  // The authenticated default surface is now the dedicated chat home page,
  // so the intro always lands on a chat-shaped shell. Keep the empty-vs-chat
  // distinction so the input bar still morphs to the right resting layout.
  function detectMode(): IntroMorphMode {
    try {
      const s = useStore.getState()
      return (s.runs?.length ?? 0) === 0 ? "empty" : "chat"
    } catch {
      return "chat"
    }
  }

  // After login succeeds, wait two frames for the shell to paint, then
  // kick off the enter animation. Fire onFading immediately so the
  // chat-home starts fading in at the same moment the login content
  // starts disappearing — they crossfade rather than sequence.
  function measureAndTrigger(_mode: IntroMorphMode) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.setTimeout(() => {
          onFading?.()        // chat-home reveal starts NOW
          setEnterTrigger(true)
        }, 80)
      }),
    )
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
        onLoginSuccess={() => {
          const mode = detectMode()
          setMorphMode(mode)
          setPhase("layered")
          measureAndTrigger(mode)
        }}
        onEntered={() => {
          // Login content has gone — start the overlay wrapper fade.
          // onFading already fired at entering start so the chat-home
          // is already well into its own fade by now.
          setPhase("fading")
        }}
      />
    </div>
  )
}


