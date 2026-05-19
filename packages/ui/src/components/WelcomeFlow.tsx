/**
 * WelcomeFlow — primary login surface for the `ui` package.
 *
 * mode="intro" renders the /intro3 conversational experience and
 * reproduces the same 3-phase hand-off the standalone IntroConversationRoute
 * uses:
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

export type WelcomeFlowProps = WelcomeFlowLegacyProps
export { WelcomeFlowLegacy }

export function WelcomeFlow(props: WelcomeFlowProps) {
  const { mode = "intro", onSubmit, onDone } = props

  // Non-intro modes (outro / reveal / switching) still play the legacy
  // mosaic animation — IntroConversation is purely an entry flow.
  if (mode !== "intro") {
    return <WelcomeFlowLegacy {...props} />
  }

  return <IntroConversationLoginAdapter onSubmit={onSubmit} onDone={onDone} />
}

/**
 * Bridges `IntroConversation`'s richer hand-off (onLoginSuccess →
 * measure → enterTrigger → onEntered → cross-fade) to `WelcomeFlowProps`'s
 * simpler `onSubmit` / `onDone` contract.
 *
 * This is the same 3-phase orchestration `IntroConversationRoute` uses
 * for /intro3 — kept identical so the login morph feels the same
 * whether the user lands on `/intro3` or on the default route. The only
 * structural difference: here we do NOT mount <App/> ourselves because
 * App.tsx is already rendering us as a `welcomeOverlay` *over* its own
 * shell body. As soon as `loginOrRegister`'s `refreshMe()` resolves,
 * App's body falls through from the blank `phase === Login && !me`
 * branch into the real shell — which is exactly the "layered" phase.
 */
function IntroConversationLoginAdapter({
  onSubmit,
  onDone,
}: {
  onSubmit: WelcomeFlowProps["onSubmit"]
  onDone:   WelcomeFlowProps["onDone"]
}) {
  const [phase, setPhase] =
    useState<"intro" | "layered" | "fading">("intro")
  const [enterTrigger, setEnterTrigger] = useState(false)
  const [morphMode,   setMorphMode]     = useState<IntroMorphMode>("chat")
  const [morphTarget, setMorphTarget]   =
    useState<IntroMorphTarget | undefined>(undefined)

  // Mirror IntroConversationRoute.detectMode — picks one of the three
  // landing "setups" based on what the dashboard will render underneath.
  function detectMode(): IntroMorphMode {
    try {
      const s = useStore.getState()
      const view = s.views.find((v) => v.id === s.activeViewId) ?? s.views[0]
      const hasTermChat = !!view?.widgets?.some((w) => w.type === "term-chat")
      if (!hasTermChat) return "nochat"
      return (s.runs?.length ?? 0) === 0 ? "empty" : "chat"
    } catch {
      return "chat"
    }
  }

  // After login succeeds (App has set `me`, its body is about to paint
  // the shell underneath us), wait for paint and measure the platform's
  // TermChat input bar so the intro input morphs to its exact rect.
  // Two rAFs + a small settle gives App's Suspense / Grid time to place
  // its children at their final coordinates — same recipe as the route.
  function measureAndTrigger(mode: IntroMorphMode) {
    const measure = () => {
      if (mode === "empty" || mode === "chat") {
        const el = document.querySelector<HTMLElement>(
          '[data-intro-target="termchat-input"]',
        )
        if (el) {
          const r = el.getBoundingClientRect()
          setMorphTarget({
            left:   r.left,
            top:    r.top,
            width:  r.width,
            height: r.height,
          })
        }
      }
      setEnterTrigger(true)
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.setTimeout(measure, 120)
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
          // Morph done → start cross-fade. onDone() fires from
          // onTransitionEnd above once the opacity transition lands.
          setPhase("fading")
        }}
      />
    </div>
  )
}


