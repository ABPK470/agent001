import { useEffect, useRef, useState } from "react"
import { ASCII_SCRAMBLE_GLYPHS } from "../IntroAsciiField"

const SETTLE_MS = 140
const SETTLE_TICK_MS = 40

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
          const g = ASCII_SCRAMBLE_GLYPHS
          const r = (Math.random() * g.length) | 0
          return <span key={i} className="intro3-crystal-cell">{g[r]}</span>
        }
        return <span key={i}>{ch}</span>
      })}
    </>
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
        const g = ASCII_SCRAMBLE_GLYPHS
        const r = ((tick + i) * 9301 + 49297) % g.length
        return <span key={i} className="intro3-crystal-cell">{g[r]}</span>
      })}
    </>
  )
}
