import { useEffect, useRef, useState } from "react"
import { ASCII_SCRAMBLE_GLYPHS } from "../IntroAsciiField"

const DEFAULT_SETTLE_MS = 70
const SETTLE_TICK_MS = 40
/** Opening greeting — calm, quick; no long glyph drip. */
export const INTRO_GREETING_SPEED_MS = 11
export const INTRO_GREETING_SETTLE_MS = 55

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

function scrambleGlyph(i: number, salt: number): string {
  const g = ASCII_SCRAMBLE_GLYPHS
  const r = Math.abs((i * 9301 + salt * 49297) % g.length)
  return g[r]!
}

/** Bot transcript — chars crystallise out of the ASCII field palette. */
export function StreamingText({
  text,
  onDone,
  speedMs = 14,
  settleMs = DEFAULT_SETTLE_MS,
  scramble = true,
}: {
  text: string
  onDone?: () => void
  speedMs?: number
  settleMs?: number
  /** When false, chars land plain (prefer for the opening greeting). */
  scramble?: boolean
}) {
  const [n, setN] = useState(0)
  const [tick, setTick] = useState(0)
  const revealedAtRef = useRef<number[]>([])
  const onDoneRef = useRef(onDone)
  useEffect(() => { onDoneRef.current = onDone }, [onDone])
  useEffect(() => { setN(0); revealedAtRef.current = [] }, [text])
  useEffect(() => {
    if (n >= text.length) {
      onDoneRef.current?.()
      return
    }
    const t = window.setTimeout(() => {
      revealedAtRef.current[n] = performance.now()
      setN((v) => v + 1)
    }, speedMs)
    return () => window.clearTimeout(t)
  }, [n, text, speedMs])
  useEffect(() => {
    if (!scramble) return
    const now = performance.now()
    const stillScrambling = revealedAtRef.current
      .slice(0, n)
      .some((ts) => ts && now - ts < settleMs)
    if (!stillScrambling) return
    const id = window.setInterval(() => setTick((v) => v + 1), SETTLE_TICK_MS)
    return () => window.clearInterval(id)
  }, [n, tick, scramble, settleMs])
  const now = performance.now()
  return (
    <>
      {text.slice(0, n).split("").map((ch, i) => {
        const at = revealedAtRef.current[i]
        const age = at ? now - at : settleMs
        if (scramble && age < settleMs && ch !== " " && ch !== "\n") {
          return <span key={i} className="intro3-crystal-cell">{scrambleGlyph(i, tick)}</span>
        }
        return <span key={i}>{ch}</span>
      })}
    </>
  )
}

/**
 * Reverse of StreamingText — chars scramble back into the ASCII field
 * then vanish, last-written first (suffix un-reveals). Driven by the
 * enter morph clock so rollback and pill travel share one timeline.
 */
export function RollbackText({
  text,
  progress,
  lag = 0,
  span = 0.4,
}: {
  text: string
  /** 0..1 enter morph progress */
  progress: number
  /** When this line starts rolling back within the morph */
  lag?: number
  /** Fraction of the morph used for this line's rollback */
  span?: number
}) {
  if (progress <= lag || text.length === 0) {
    return <>{text}</>
  }
  const local = smoothstep((progress - lag) / Math.max(0.001, span))
  const keep = Math.max(0, Math.ceil(text.length * (1 - local)))
  const scrambleFrom = Math.max(0, keep - 3)
  const salt = Math.floor(progress * 56)

  return (
    <span className="intro3-decay">
      {text.split("").map((ch, i) => {
        if (i >= keep) return null
        if (i >= scrambleFrom && ch !== " " && ch !== "\n") {
          return (
            <span key={i} className="intro3-decay-cell intro3-decay-cell--scramble intro3-crystal-cell">
              {scrambleGlyph(i, salt)}
            </span>
          )
        }
        return <span key={i}>{ch}</span>
      })}
    </span>
  )
}
