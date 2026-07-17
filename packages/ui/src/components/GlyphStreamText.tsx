import { useEffect, useRef, useState } from "react"
import { ASCII_FIELD_SCRAMBLE_GLYPHS } from "../lib/ascii-noise"

const SETTLE_MS = 140
const SETTLE_TICK_MS = 40

/**
 * Live streaming text — new characters briefly show as ASCII field glyphs
 * then settle into prose. No blinking cursor; growth is driven by SSE chunks.
 */
export function GlyphStreamText({
  text,
  className = "",
}: {
  text: string
  className?: string
}) {
  const revealedAtRef = useRef<number[]>([])
  const prevLenRef = useRef(0)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const now = performance.now()
    for (let i = prevLenRef.current; i < text.length; i++) {
      revealedAtRef.current[i] = now
    }
    prevLenRef.current = text.length
  }, [text])

  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), SETTLE_TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  if (!text) return null

  const now = performance.now()
  const glyphs = ASCII_FIELD_SCRAMBLE_GLYPHS

  return (
    <span className={className}>
      {text.split("").map((ch, i) => {
        const at = revealedAtRef.current[i]
        const age = at ? now - at : SETTLE_MS
        if (age < SETTLE_MS && ch !== " " && ch !== "\n") {
          const r = ((tick + i) * 9301 + 49297) % glyphs.length
          return (
            <span key={i} className="glyph-stream-cell">
              {glyphs[r]}
            </span>
          )
        }
        return <span key={i}>{ch}</span>
      })}
    </span>
  )
}
