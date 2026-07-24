/**
 * Intro brand — : lands → pinch → mass grows from colon (MI left, then A right)
 * → sculpt-carve (cut mass to letter shapes) → letters seated. No rotate.
 * On send name: colon only — abort in-flight MI:A, never continue it.
 */

import { useEffect, useRef, useState } from "react"
import { CHAT_BRAND_LOGO_SIZE } from "../../brand"
import { Logo } from "../../../components/Logo"

/** TEMP inspect — whole MI:A sequence. Restore to 1 when done. */
const DEBUG_SLOWDOWN = 5

const REVEAL_DELAY_MS = 80 * DEBUG_SLOWDOWN
/** : land — keep in sync with `.intro3-wm-mark--handoff` duration. */
const COLON_LAND_MS = 520 * DEBUG_SLOWDOWN
const HOLD_BEFORE_PINCH_MS = 200 * DEBUG_SLOWDOWN
/** Meet + shed/carve — keep in sync with clay + pinch-shed CSS. */
const PINCH_MS = 1200 * DEBUG_SLOWDOWN
const HOLD_AFTER_CARVE_MS = 160 * DEBUG_SLOWDOWN
/** Fade + collapse MI:A, then scale : in place — matches CSS resolve. */
const RESOLVE_MS = 220 * DEBUG_SLOWDOWN

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

type BrandPhase =
  | "boot"
  | "colon"
  | "pinch"
  | "open"
  | "resolve"
  | "live"

function lettersVisibleIn(phase: BrandPhase): boolean {
  return phase === "pinch" || phase === "open"
}

/**
 * Mass grows from the colon edge (slot width) — never slides across `:`.
 * Clay is solid fill; carve cuts that fill down to the letter shapes (sculpture).
 */
function BrandMass({
  text,
  side,
}: {
  text: string
  side: "pre" | "post"
}) {
  return (
    <span
      className={[
        "intro3-wm-slot",
        side === "pre" ? "intro3-wm-slot--pre" : "intro3-wm-slot--post",
      ].join(" ")}
      aria-hidden="true"
    >
      <span className="intro3-wm-clay">{text}</span>
    </span>
  )
}

/** Header brand: : → shed/carve MI:A → open (input after). Send → colon only. */
export function IntroBrandWordmark({
  onBrandReady,
  onBrandLive,
  beginReveal,
  beginResolve,
  serverReachable,
}: {
  onBrandReady?: () => void
  onBrandLive?: () => void
  /** Greeting has landed — start the : appearance. */
  beginReveal: boolean
  /** Name sent (left hero) — colon only; never continue MI:A. */
  beginResolve: boolean
  serverReachable: boolean
}) {
  const [phase, setPhase] = useState<BrandPhase>("boot")
  const [colonHandoff, setColonHandoff] = useState(false)
  const phaseRef = useRef<BrandPhase>("boot")
  const skipMiaRef = useRef(false)
  const revealStartedRef = useRef(false)
  const resolveStartedRef = useRef(false)
  const brandReadyRef = useRef(false)
  const onBrandReadyRef = useRef(onBrandReady)
  const onBrandLiveRef = useRef(onBrandLive)
  useEffect(() => { onBrandReadyRef.current = onBrandReady }, [onBrandReady])
  useEffect(() => { onBrandLiveRef.current = onBrandLive }, [onBrandLive])
  useEffect(() => { phaseRef.current = phase }, [phase])

  function markBrandReady() {
    if (brandReadyRef.current) return
    brandReadyRef.current = true
    onBrandReadyRef.current?.()
  }

  function goColonOnly(from: BrandPhase) {
    setColonHandoff(false)
    if (lettersVisibleIn(from)) {
      setPhase("resolve")
      window.setTimeout(() => {
        setPhase("live")
      }, RESOLVE_MS)
    } else {
      setPhase("live")
    }
    markBrandReady()
  }

  useEffect(() => {
    if (phase !== "live") return
    onBrandLiveRef.current?.()
  }, [phase])

  useEffect(() => {
    if (!colonHandoff) return
    const t = window.setTimeout(() => setColonHandoff(false), COLON_LAND_MS)
    return () => window.clearTimeout(t)
  }, [colonHandoff])

  // Name sent: MI:A off the table — colon only, abort any in-flight reveal.
  useEffect(() => {
    if (!serverReachable || !beginResolve) return
    if (resolveStartedRef.current) return
    resolveStartedRef.current = true
    skipMiaRef.current = true
    goColonOnly(phaseRef.current)
  }, [beginResolve, serverReachable])

  useEffect(() => {
    if (!serverReachable || !beginReveal) return
    if (revealStartedRef.current) return
    revealStartedRef.current = true
    // Parent installs a fresh ready latch when reveal begins — allow fire again.
    brandReadyRef.current = false

    // Name already sent before : was due — colon only, never MI:A.
    if (skipMiaRef.current) {
      setPhase("live")
      markBrandReady()
      return
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setPhase(skipMiaRef.current ? "live" : "open")
      markBrandReady()
      return
    }

    let cancelled = false
    const aborted = () => cancelled || skipMiaRef.current

    const run = async () => {
      await sleep(REVEAL_DELAY_MS)
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      // 1) Logo lands fully.
      setPhase("colon")
      setColonHandoff(true)
      await sleep(COLON_LAND_MS)
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      await sleep(HOLD_BEFORE_PINCH_MS)
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      // 2) Shed mass + carve letters (no rotation after).
      setPhase("pinch")
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      await sleep(PINCH_MS)
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      // 3) MI:A seated — unlock input.
      setPhase("open")
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      await sleep(HOLD_AFTER_CARVE_MS)
      if (aborted()) {
        goColonOnly(phaseRef.current)
        return
      }
      markBrandReady()
    }

    void run().catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [beginReveal, serverReachable])

  if (!serverReachable) {
    return (
      <Logo
        size={CHAT_BRAND_LOGO_SIZE}
        online={false}
        className="toolbar-brand-logo"
      />
    )
  }

  const lettersSeated =
    phase === "pinch"
    || phase === "open"
    || phase === "resolve"
    || phase === "live"

  /** Purple mark while MI:A is up; idle rotate only when letters are gone. */
  const colonAccent =
    phase === "open"
    || phase === "resolve"
    || phase === "live"
  const colonOnline = phase === "live"

  const sequenceClass = [
    "intro3-brand-sequence",
    lettersSeated ? "intro3-brand-sequence--open" : "intro3-brand-sequence--closed",
    phase === "pinch" ? "intro3-brand-sequence--pinching" : "",
    phase === "resolve" ? "intro3-brand-sequence--resolving" : "",
    phase === "live" ? "intro3-brand-sequence--live" : "",
  ].filter(Boolean).join(" ")

  const markClassName = [
    "intro3-wm-mark",
    "toolbar-brand-logo",
    phase !== "boot" ? "intro3-wm-mark--in" : "",
    colonHandoff ? "intro3-wm-mark--handoff" : "",
    colonAccent ? "intro3-wm-mark--purple" : "",
    phase === "live" ? "intro3-wm-mark--solo" : "",
    phase === "pinch" ? "intro3-wm-mark--pinching mia-colon-logo--pinch-shed" : "",
  ].filter(Boolean).join(" ")

  return (
    <span className={sequenceClass} aria-label={phase === "live" ? ":" : "MI:A"}>
      <BrandMass text="MI" side="pre" />
      <span className="intro3-wm-colon-anchor intro3-wm-colon-anchor--locked">
        <Logo
          size={CHAT_BRAND_LOGO_SIZE}
          online={colonOnline}
          className={markClassName}
        />
      </span>
      <BrandMass text="A" side="post" />
    </span>
  )
}
