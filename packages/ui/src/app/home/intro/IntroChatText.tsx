import { useEffect, useRef, useState } from "react"
import { ASCII_SCRAMBLE_GLYPHS } from "../IntroAsciiField"

const SETTLE_MS = 140
const SETTLE_TICK_MS = 40

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
  speedMs = 22,
}: {
  text: string
  onDone?: () => void
  speedMs?: number
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
    const now = performance.now()
    const stillScrambling = revealedAtRef.current
      .slice(0, n)
      .some((ts) => ts && now - ts < SETTLE_MS)
    if (!stillScrambling) return
    const id = window.setInterval(() => setTick((v) => v + 1), SETTLE_TICK_MS)
    return () => window.clearInterval(id)
  }, [n, tick])
  const now = performance.now()
  return (
    <>
      {text.slice(0, n).split("").map((ch, i) => {
        const at = revealedAtRef.current[i]
        const age = at ? now - at : SETTLE_MS
        if (age < SETTLE_MS && ch !== " " && ch !== "\n") {
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

/** Activity shimmer — label continuously coalescing from the field. */
export function CrystalText({ text }: { text: string }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 110)
    return () => window.clearInterval(id)
  }, [])
  const scrambleSet = new Set<number>()
  const slots = Math.max(1, Math.floor(text.length * 0.18))
  for (let i = 0; i < slots; i++) {
    const idx = ((tick + i * 3) % text.length + text.length) % text.length
    scrambleSet.add(idx)
  }
  return (
    <>
      {text.split("").map((ch, i) => {
        if (ch === " " || !scrambleSet.has(i)) return <span key={i}>{ch}</span>
        return <span key={i} className="intro3-crystal-cell">{scrambleGlyph(i, tick)}</span>
      })}
    </>
  )
}
