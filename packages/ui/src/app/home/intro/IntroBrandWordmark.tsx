/**
 * Intro brand — one pinch that sheds mass:
 * show : → pinch (: → .) sheds full-colon-height off-white blobs into MI / A
 * → colon opens → rotate → live idle until input
 * → on input: quick MI:A remove + downsize (no reverse blobs)
 *
 * TEMP: only the : appearance is slowed (DEBUG_SLOWDOWN). Everything after is 1×.
 */

import { useEffect, useRef, useState } from "react"
import { CHAT_BRAND_LOGO_SIZE } from "../../brand"
import { Logo } from "../../../components/Logo"

/** Temporary — only slows the : land. Restore to 1 when done inspecting. */
const DEBUG_SLOWDOWN = 8

const REVEAL_DELAY_MS = 180
/** Only this beat stays slow. */
const COLON_LAND_MS = 420 * DEBUG_SLOWDOWN
const HOLD_BEFORE_PINCH_MS = 180
const PINCH_MEET_MS = 320
const PINCH_SHED_MS = 560
const PINCH_MS = PINCH_MEET_MS + PINCH_SHED_MS
const ROTATE_MS = 1000
const HOLD_AFTER_ROTATE_MS = 120
/** Quick collapse of MI:A + downsize — no reverse blobs. */
const RESOLVE_MS = 280
const LIVE_PAUSE_MS = 40
const RESOLVE_DELAY_MS = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

type BrandPhase =
  | "boot"
  | "colon"
  | "pinch"
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

/** Header brand: one pinch sheds MI:A → rotate → live : */
export function IntroBrandWordmark({
  onBrandReady,
  onBrandLive,
  beginReveal,
  beginResolve,
  serverReachable,
}: {
  onBrandReady?: () => void
  onBrandLive?: () => void
  /** Greeting + pill have landed — start the : appearance. */
  beginReveal: boolean
  beginResolve: boolean
  serverReachable: boolean
}) {
  const [phase, setPhase] = useState<BrandPhase>("boot")
  const [colonHandoff, setColonHandoff] = useState(false)
  const [brandReady, setBrandReady] = useState(false)
  const brandReadyRef = useRef(false)
  const revealStartedRef = useRef(false)
  const resolveStartedRef = useRef(false)
  const onBrandReadyRef = useRef(onBrandReady)
  const onBrandLiveRef = useRef(onBrandLive)
  useEffect(() => { onBrandReadyRef.current = onBrandReady }, [onBrandReady])
  useEffect(() => { onBrandLiveRef.current = onBrandLive }, [onBrandLive])

  useEffect(() => {
    if (serverReachable) return
    if (brandReadyRef.current) return
    brandReadyRef.current = true
    setBrandReady(true)
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
    if (!serverReachable || !beginReveal) return
    if (revealStartedRef.current) return
    revealStartedRef.current = true
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setPhase("open")
      brandReadyRef.current = true
      setBrandReady(true)
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
      await sleep(HOLD_BEFORE_PINCH_MS)
      if (cancelled) return
      // One pinch: : → . sheds full off-white blobs → letters → opens to :
      setPhase("pinch")
      await sleep(PINCH_MS)
      if (cancelled) return
      setPhase("rotate")
      await sleep(ROTATE_MS)
      if (cancelled) return
      setPhase("open")
      await sleep(HOLD_AFTER_ROTATE_MS)
      if (cancelled) return
      brandReadyRef.current = true
      setBrandReady(true)
      onBrandReadyRef.current?.()
    }

    void run().catch((err: unknown) => { console.error("[mia]", err) })
    return () => { cancelled = true }
  }, [beginReveal, serverReachable])

  useEffect(() => {
    if (!serverReachable) return
    if (!beginResolve || !brandReady || resolveStartedRef.current) return
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
  }, [beginResolve, serverReachable, brandReady])

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
    || phase === "rotate"
    || phase === "open"
    || phase === "resolve"

  const colonLive =
    phase === "open"
    || phase === "resolve"
    || phase === "live"

  const sequenceClass = [
    "intro3-brand-sequence",
    lettersSeated ? "intro3-brand-sequence--open" : "intro3-brand-sequence--closed",
    phase === "pinch" ? "intro3-brand-sequence--pinching" : "",
    phase === "rotate" ? "intro3-brand-sequence--rotating" : "",
    phase === "resolve" ? "intro3-brand-sequence--resolving" : "",
    phase === "live" ? "intro3-brand-sequence--live" : "",
  ].filter(Boolean).join(" ")

  const markClassName = [
    "intro3-wm-mark",
    "toolbar-brand-logo",
    phase !== "boot" ? "intro3-wm-mark--in" : "",
    colonHandoff ? "intro3-wm-mark--handoff" : "",
    colonLive || phase === "rotate" ? "intro3-wm-mark--purple" : "",
    phase === "live" ? "intro3-wm-mark--solo" : "",
    phase === "pinch" ? "intro3-wm-mark--pinching mia-colon-logo--pinch-shed" : "",
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
          online={colonLive}
          className={markClassName}
        />
      </span>
      <BrandLetter ch="A" side="post" index={0} />
    </span>
  )
}
