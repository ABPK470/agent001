/**
 * Live streaming prose — paced reveal with a short ASCII settle.
 *
 * Markdown never goes through here (callers only pass plain prose). New
 * characters crystallise from the field palette, then settle to the real
 * glyph. Width thrash is limited by monospace scramble cells.
 */

import { useEffect, useRef, useState } from "react"
import { ASCII_FIELD_SCRAMBLE_GLYPHS as ASCII_SCRAMBLE_GLYPHS } from "../lib/ascii-noise"

const SETTLE_MS = 160
const SETTLE_TICK_MS = 40
/** Calm reading pace — SSE bursts are buffered behind this drip. */
const CHARS_PER_SECOND = 36
const CATCHUP_CHARS_PER_SECOND = 72
const CATCHUP_BEHIND = 48

function scrambleGlyph(i: number, salt: number): string {
  const g = ASCII_SCRAMBLE_GLYPHS
  const r = Math.abs((i * 9301 + salt * 49297) % g.length)
  return g[r]!
}

export function GlyphStreamText({
  text,
  className = "",
}: {
  text: string
  className?: string
}) {
  const [shown, setShown] = useState(0)
  const [tick, setTick] = useState(0)
  const revealedAtRef = useRef<number[]>([])
  const shownRef = useRef(0)
  const targetRef = useRef(text)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)

  targetRef.current = text

  useEffect(() => {
    if (text.length < shownRef.current) {
      shownRef.current = 0
      revealedAtRef.current = []
      setShown(0)
    }
  }, [text])

  useEffect(() => {
    let cancelled = false

    const step = (now: number) => {
      if (cancelled) return
      const target = targetRef.current.length
      const cur = shownRef.current
      if (cur >= target) {
        lastTickRef.current = null
        rafRef.current = null
        return
      }

      const last = lastTickRef.current ?? now
      const dt = Math.min(now - last, 50)
      lastTickRef.current = now
      const behind = target - cur
      const cps = behind > CATCHUP_BEHIND ? CATCHUP_CHARS_PER_SECOND : CHARS_PER_SECOND
      const advance = Math.max(1, Math.ceil((cps * dt) / 1000))
      const next = Math.min(target, cur + advance)
      const stamp = performance.now()
      for (let i = cur; i < next; i++) {
        revealedAtRef.current[i] = stamp
      }
      shownRef.current = next
      setShown(next)
      rafRef.current = requestAnimationFrame(step)
    }

    rafRef.current = requestAnimationFrame(step)
    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTickRef.current = null
    }
  }, [text])

  useEffect(() => {
    const now = performance.now()
    const scrambling = revealedAtRef.current
      .slice(0, shown)
      .some((ts) => ts != null && now - ts < SETTLE_MS)
    if (!scrambling) return
    const id = window.setInterval(() => setTick((v) => v + 1), SETTLE_TICK_MS)
    return () => window.clearInterval(id)
  }, [shown, tick, text])

  if (!text || shown <= 0) return null

  const visible = text.slice(0, shown)
  const now = performance.now()

  return (
    <span className={["glyph-stream-text", className].filter(Boolean).join(" ")}>
      {visible.split("").map((ch, i) => {
        const at = revealedAtRef.current[i]
        const age = at != null ? now - at : SETTLE_MS
        if (age < SETTLE_MS && ch !== " " && ch !== "\n") {
          return (
            <span key={i} className="glyph-stream-cell" aria-hidden="true">
              {scrambleGlyph(i, tick)}
            </span>
          )
        }
        return <span key={i}>{ch}</span>
      })}
      <span className="glyph-stream-cue" aria-hidden="true" />
    </span>
  )
}
