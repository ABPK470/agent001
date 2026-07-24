/**
 * Intro brand — sequential:
 * show : → pinch → shed mass to letter seats → letters lock → rotate :
 * → rest MI:A → (resolve) letters retract to live :
 */

import { useEffect, useRef, useState } from "react"
import { CHAT_BRAND_LOGO_SIZE } from "../../brand"
import { Logo } from "../../../components/Logo"

const REVEAL_DELAY_MS = 180
const COLON_LAND_MS = 420
const HOLD_BEFORE_FORGE_MS = 180
/** Pinch + shed mass into letter positions. */
const FORGE_MS = 720
/** One rotate after letters are up. */
const ROTATE_MS = 1000
const HOLD_AFTER_ROTATE_MS = 200
/** Letters retract when leaving hero — no second pinch/rotate. */
const RESOLVE_MS = 520
const LIVE_PAUSE_MS = 100
const RESOLVE_DELAY_MS = 40

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

type BrandPhase =
  | "boot"
  | "colon"
  | "forge"
  | "rotate"
  | "open"
  | "resolve"
  | "live"

function BrandLetter({
  ch,
  side,
  index,
}: {
  ch: string
  side: "pre" | "post"
  index: number
}) {
  return (
    <span
      className={[
        "intro3-wm-slot",
        side === "pre" ? "intro3-wm-slot--pre" : "intro3-wm-slot--post",
        `intro3-wm-slot--i${index}`,
      ].join(" ")}
      aria-hidden="true"
    >
      <span className="intro3-wm-letter">{ch}</span>
    </span>
  )
}

/** Header brand: : pinch-shed → letters → rotate → live : */
export function IntroBrandWordmark({
  onBrandReady,
  onBrandLive,
  beginResolve,
  serverReachable,
}: {
  onBrandReady?: () => void
  onBrandLive?: () => void
  beginResolve: boolean
  serverReachable: boolean
}) {
  const [phase, setPhase] = useState<BrandPhase>("boot")
  const [colonHandoff, setColonHandoff] = useState(false)
  const brandReadyRef = useRef(false)
  const resolveStartedRef = useRef(false)
  const onBrandReadyRef = useRef(onBrandReady)
  const onBrandLiveRef = useRef(onBrandLive)
  useEffect(() => { onBrandReadyRef.current = onBrandReady }, [onBrandReady])
  useEffect(() => { onBrandLiveRef.current = onBrandLive }, [onBrandLive])

  useEffect(() => {
    if (serverReachable) return
    if (brandReadyRef.current) return
    brandReadyRef.current = true
    onBrandReadyRef.current?.()
  }, [serverReachable])

  useEffect(() => {
    if (phase !== "live") return
    onBrandLiveRef.current?.()
  }, [phase])

  useEffect(() => {
    if (!colonHandoff) return
    const t = window.setTimeout(() => setColonHandoff(false), COLON_LAND_MS)
    return () => window.clearTimeout(t)
  }, [colonHandoff])

  useEffect(() => {
    if (!serverReachable) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setPhase("open")
      brandReadyRef.current = true
      onBrandReadyRef.current?.()
      return
    }

    let cancelled = false
    const run = async () => {
      await sleep(REVEAL_DELAY_MS)
      if (cancelled) return
      setPhase("colon")
      setColonHandoff(true)
      await sleep(COLON_LAND_MS)
      if (cancelled) return
      await sleep(HOLD_BEFORE_FORGE_MS)
      if (cancelled) return
      setPhase("forge")
      await sleep(FORGE_MS)
      if (cancelled) return
      setPhase("rotate")
      await sleep(ROTATE_MS)
      if (cancelled) return
      setPhase("open")
      await sleep(HOLD_AFTER_ROTATE_MS)
      if (cancelled) return
      brandReadyRef.current = true
      onBrandReadyRef.current?.()
    }

    void run().catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [serverReachable])

  useEffect(() => {
    if (!serverReachable) return
    if (!beginResolve || !brandReadyRef.current || resolveStartedRef.current) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setPhase("live")
      return
    }

    resolveStartedRef.current = true
    let cancelled = false
    const run = async () => {
      await sleep(RESOLVE_DELAY_MS)
      if (cancelled) return
      setPhase("resolve")
      await sleep(RESOLVE_MS)
      if (cancelled) return
      setPhase("live")
      await sleep(LIVE_PAUSE_MS)
    }

    void run().catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [beginResolve, serverReachable])

  if (!serverReachable) {
    return (
      <Logo
        size={CHAT_BRAND_LOGO_SIZE}
        online={false}
        className="toolbar-brand-logo"
      />
    )
  }

  const lettersOpen =
    phase === "forge"
    || phase === "rotate"
    || phase === "open"
    || phase === "resolve"

  const sequenceClass = [
    "intro3-brand-sequence",
    lettersOpen ? "intro3-brand-sequence--open" : "intro3-brand-sequence--closed",
    phase === "forge" ? "intro3-brand-sequence--forging" : "",
    phase === "rotate" ? "intro3-brand-sequence--rotating" : "",
    phase === "resolve" ? "intro3-brand-sequence--resolving" : "",
    phase === "live" ? "intro3-brand-sequence--live" : "",
  ].filter(Boolean).join(" ")

  const markClassName = [
    "intro3-wm-mark",
    "toolbar-brand-logo",
    phase !== "boot" ? "intro3-wm-mark--in" : "",
    colonHandoff ? "intro3-wm-mark--handoff" : "",
    phase === "live" || phase === "resolve" || phase === "rotate" || phase === "open"
      ? "intro3-wm-mark--purple"
      : "",
    phase === "live" ? "intro3-wm-mark--solo" : "",
    phase === "forge" ? "intro3-wm-mark--forging mia-colon-logo--pinch-forge" : "",
    phase === "rotate" ? "intro3-wm-mark--rotating mia-colon-logo--rotate-resolve" : "",
  ].filter(Boolean).join(" ")

  return (
    <span className={sequenceClass} aria-label="MI:A">
      <BrandLetter ch="M" side="pre" index={1} />
      <BrandLetter ch="I" side="pre" index={0} />
      <span className="intro3-wm-colon-anchor intro3-wm-colon-anchor--locked">
        <span className="intro3-wm-ejecta intro3-wm-ejecta--left" aria-hidden="true" />
        <span className="intro3-wm-ejecta intro3-wm-ejecta--right" aria-hidden="true" />
        <Logo
          size={CHAT_BRAND_LOGO_SIZE}
          online={phase === "live"}
          className={markClassName}
        />
      </span>
      <BrandLetter ch="A" side="post" index={0} />
    </span>
  )
}
