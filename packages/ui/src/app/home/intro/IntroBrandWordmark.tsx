import { useEffect, useRef, useState, type CSSProperties } from "react"
import {
  CHAT_BRAND_LOGO_SIZE,
  INTRO_COLON_EMBEDDED_SIZE,
} from "../../brand"
import { ASCII_FIELD_SCRAMBLE_GLYPHS } from "../../../lib/ascii-noise"
import { Logo } from "../../../components/Logo"

const COLON_EMBEDDED_SCALE = INTRO_COLON_EMBEDDED_SIZE / CHAT_BRAND_LOGO_SIZE

/**
 * Lone colon after letters leave. Stays at embedded optical size until
 * `settle` (same beat as the purple tint), then eases to the forever mark.
 */
function SettlingColonMark({
  online,
  className,
  settle,
}: {
  online: boolean
  className: string
  settle: boolean
}) {
  return (
    <span
      className={`intro3-wm-mark-settle${settle ? " intro3-wm-mark-settle--done" : ""}`}
      style={{ "--wm-colon-settle-from": String(COLON_EMBEDDED_SCALE) } as CSSProperties}
    >
      <Logo size={CHAT_BRAND_LOGO_SIZE} online={online} className={className} />
    </span>
  )
}

const WM_REVEAL_DELAY_MS = 220
const BRAND_COLON_INTRO_MS = 320
const BRAND_PINCH_CLOSE_MS = 390
const WM_LETTER_SNAP_MS = 85
const WM_SCRAMBLE_TICK_MS = 35
const WM_LETTER_STAGGER_MS = 32
const BRAND_PINCH_PAUSE_MS = 760
const BRAND_ROTATE_DUR_MS = 1200
const BRAND_RESOLVE_DELAY_MS = 280
const BRAND_LIVE_PAUSE_MS = 380
const BRAND_PRE_ROTATE_PAUSE_MS = 340
const RETRACT_SCRAMBLE_MS = 85
const RETRACT_COLLAPSE_MS = 240
const BRAND_A_RETRACT_DELAY_MS = 100

function wmRandomGlyph(seed: number): string {
  const i = Math.abs((seed * 9301 + 49297) % ASCII_FIELD_SCRAMBLE_GLYPHS.length)
  return ASCII_FIELD_SCRAMBLE_GLYPHS[i]!
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

type BrandLetterState = "hidden" | "locked" | "scrambling" | "retracting" | "retracted"
interface BrandLetter { state: BrandLetterState; glyph: string }

function BrandLetterSlot({
  cell,
  fromPinch = false,
  snapFrom,
}: {
  cell: BrandLetter
  fromPinch?: boolean
  snapFrom?: "left" | "right"
}) {
  if (cell.state === "retracted") return null
  const collapsing = cell.state === "retracting" && cell.glyph === ""
  const snapping = cell.state === "scrambling"
  return (
    <span
      className={`intro3-wm-slot${snapping && snapFrom ? ` intro3-wm-slot--snap-${snapFrom}` : ""}${fromPinch ? " intro3-wm-slot--from-pinch" : ""}${collapsing ? " intro3-wm-slot--collapse" : ""}${cell.state === "retracting" ? " intro3-wm-slot--retracting" : ""}${cell.state === "hidden" ? " intro3-wm-slot--hidden" : ""}`}
    >
      <span
        className={`intro3-wm-letter${snapping || (cell.state === "retracting" && cell.glyph) ? " intro3-wm-scramble" : ""}${cell.state === "locked" ? " intro3-wm-letter--locked" : ""}`}
      >
        {cell.state === "hidden" || collapsing ? "\u00A0" : cell.glyph}
      </span>
    </span>
  )
}

/** Header brand: : → pinch MI…A → optional resolve → live loop */
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
  const [miCells, setMiCells] = useState<BrandLetter[]>([
    { state: "hidden", glyph: "" },
    { state: "hidden", glyph: "" },
  ])
  const [aCell, setACell] = useState<BrandLetter>({ state: "hidden", glyph: "" })
  const [colonHandoff, setColonHandoff] = useState(false)
  const [markShown, setMarkShown] = useState(false)
  const [pinchIntro, setPinchIntro] = useState(false)
  const [pinchForge, setPinchForge] = useState(false)
  const [rotateResolve, setRotateResolve] = useState(false)
  const [markPurple, setMarkPurple] = useState(false)
  const [markLive, setMarkLive] = useState(false)
  const [aVisible, setAVisible] = useState(false)
  const brandReadyRef = useRef(false)
  const resolveStartedRef = useRef(false)
  const pinchIntroStartedRef = useRef(false)
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
    if (!markLive) return
    onBrandLiveRef.current?.()
  }, [markLive])

  useEffect(() => {
    if (!colonHandoff) return
    const t = window.setTimeout(() => setColonHandoff(false), 220)
    return () => window.clearTimeout(t)
  }, [colonHandoff])

  const introduceColon = async () => {
    setMarkShown(true)
    setColonHandoff(true)
    await sleep(BRAND_COLON_INTRO_MS)
  }

  const pinchCreateMiA = async () => {
    setPinchIntro(true)
    await sleep(BRAND_PINCH_CLOSE_MS)
    setAVisible(true)
    await snapMiA()
    setPinchIntro(false)
  }

  const snapLetter = async (
    apply: (cell: BrandLetter) => void,
    target: string,
    seed: number,
    delayMs: number,
  ) => {
    if (delayMs > 0) await sleep(delayMs)
    apply({ state: "scrambling", glyph: wmRandomGlyph(seed) })
    const startedAt = performance.now()
    while (performance.now() - startedAt < WM_LETTER_SNAP_MS) {
      apply({ state: "scrambling", glyph: wmRandomGlyph(Math.floor(performance.now()) + seed) })
      await sleep(WM_SCRAMBLE_TICK_MS)
    }
    apply({ state: "locked", glyph: target })
  }

  const snapMiA = async () => {
    await Promise.all([
      snapLetter(
        (cell) => {
          setMiCells((prev) => {
            const next = prev.slice()
            next[0] = cell
            return next
          })
        },
        "M",
        3,
        0,
      ),
      snapLetter(
        (cell) => {
          setMiCells((prev) => {
            const next = prev.slice()
            next[1] = cell
            return next
          })
        },
        "I",
        7,
        WM_LETTER_STAGGER_MS,
      ),
      snapLetter((cell) => setACell(cell), "A", 11, WM_LETTER_STAGGER_MS * 2),
    ])
  }

  const retractMiTogether = async () => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < RETRACT_SCRAMBLE_MS) {
      setMiCells((prev) =>
        prev.map((cell, i) => ({
          ...cell,
          state: "retracting" as const,
          glyph: wmRandomGlyph(Math.floor(performance.now()) + i * 11),
        })),
      )
      await sleep(WM_SCRAMBLE_TICK_MS)
    }
    setMiCells((prev) =>
      prev.map((cell) => ({ ...cell, state: "retracting" as const, glyph: "" })),
    )
    await sleep(RETRACT_COLLAPSE_MS)
    setMiCells((prev) =>
      prev.map(() => ({ state: "retracted" as const, glyph: "" })),
    )
  }

  const retractA = async () => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < RETRACT_SCRAMBLE_MS) {
      const g = wmRandomGlyph(Math.floor(performance.now()) + 17)
      setACell({ state: "retracting", glyph: g })
      await sleep(WM_SCRAMBLE_TICK_MS)
    }
    setACell({ state: "retracting", glyph: "" })
    await sleep(RETRACT_COLLAPSE_MS)
    setACell({ state: "retracted", glyph: "" })
  }

  useEffect(() => {
    if (!serverReachable) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setMiCells(["M", "I"].map((ch) => ({ state: "locked", glyph: ch })))
      setMarkShown(true)
      setACell({ state: "locked", glyph: "A" })
      setAVisible(true)
      brandReadyRef.current = true
      onBrandReadyRef.current?.()
      return
    }

    let cancelled = false
    const run = async () => {
      await sleep(WM_REVEAL_DELAY_MS)
      if (cancelled) return
      await introduceColon()
      if (cancelled) return
      if (pinchIntroStartedRef.current) return
      pinchIntroStartedRef.current = true
      await pinchCreateMiA()
      if (cancelled) return
      await sleep(BRAND_PINCH_PAUSE_MS)
      if (cancelled) return
      brandReadyRef.current = true
      onBrandReadyRef.current?.()
    }

    void run()
    return () => { cancelled = true }
  }, [serverReachable])

  useEffect(() => {
    if (!serverReachable) return
    if (!beginResolve || !brandReadyRef.current || resolveStartedRef.current) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      setMiCells((prev) => prev.map(() => ({ state: "retracted", glyph: "" })))
      setMarkPurple(true)
      setAVisible(false)
      setMarkLive(true)
      return
    }

    resolveStartedRef.current = true
    let cancelled = false

    const run = async () => {
      await sleep(BRAND_RESOLVE_DELAY_MS)
      if (cancelled) return
      await retractMiTogether()
      if (cancelled) return
      await sleep(BRAND_A_RETRACT_DELAY_MS)
      if (cancelled) return
      await retractA()
      if (cancelled) return
      setAVisible(false)
      await sleep(BRAND_PRE_ROTATE_PAUSE_MS)
      if (cancelled) return
      setRotateResolve(true)
      await sleep(BRAND_ROTATE_DUR_MS)
      if (cancelled) return
      setRotateResolve(false)
      setMarkPurple(true)
      await sleep(BRAND_LIVE_PAUSE_MS)
      if (cancelled) return
      setPinchForge(false)
      setMarkLive(true)
    }

    void run()
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

  const markAnimClass =
    markLive
      ? ""
      : `${pinchIntro ? " mia-colon-logo--pinch-intro" : ""}${pinchForge ? " mia-colon-logo--pinch-forge" : ""}${rotateResolve ? " mia-colon-logo--rotate-resolve" : ""}`.trim()

  // Letters gone → settle to the forever mark size (same as home / toolbar).
  const markSolo = miCells.every((c) => c.state === "retracted") && !aVisible

  const soloMarkClassName = [
    "toolbar-brand-logo",
    "intro3-wm-mark--solo",
    markPurple && !markLive ? "intro3-wm-mark--purple" : "",
    markAnimClass,
  ].filter(Boolean).join(" ")

  if (markSolo || markLive) {
    return (
      <SettlingColonMark
        online={markLive}
        settle={markPurple || markLive}
        className={markLive ? "toolbar-brand-logo intro3-wm-mark--solo" : soloMarkClassName}
      />
    )
  }

  const markClassName = [
    "intro3-wm-mark",
    "toolbar-brand-logo",
    markShown ? "intro3-wm-mark--in" : "",
    colonHandoff ? "intro3-wm-mark--handoff" : "",
    markPurple && !rotateResolve ? "intro3-wm-mark--purple" : "",
    markAnimClass,
  ].filter(Boolean).join(" ")

  return (
    <span className="intro3-brand-sequence" aria-label="MI:A">
      <BrandLetterSlot cell={miCells[0]!} snapFrom="left" />
      <BrandLetterSlot cell={miCells[1]!} snapFrom="left" />
      <span className="intro3-wm-colon-anchor intro3-wm-colon-anchor--locked">
        <Logo
          size={INTRO_COLON_EMBEDDED_SIZE}
          online={markLive}
          className={markClassName}
        />
      </span>
      {aVisible ? <BrandLetterSlot cell={aCell} snapFrom="right" /> : null}
    </span>
  )
}
