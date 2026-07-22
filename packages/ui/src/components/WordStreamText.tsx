/**
 * Live streaming prose — word cadence, no glyph scramble.
 *
 * Callers only pass plain prose (markdown-shaped tails are held elsewhere).
 * New words appear at a calm reading pace; SSE bursts buffer behind this drip.
 */

import { useEffect, useRef, useState } from "react"

/** Calm reading pace — roughly conversational. */
const WORDS_PER_SECOND = 5
const CATCHUP_WORDS_PER_SECOND = 12
/** Catch up when the buffer is more than this many characters ahead. */
const CATCHUP_BEHIND_CHARS = 64

/** Advance `from` past the next `wordCount` words (and their trailing whitespace). */
export function advanceByWords(text: string, from: number, wordCount: number): number {
  let i = Math.max(0, from)
  for (let w = 0; w < wordCount && i < text.length; w++) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (i >= text.length) break
    while (i < text.length && !/\s/.test(text[i]!)) i++
    while (i < text.length && /\s/.test(text[i]!)) i++
  }
  return i
}

export function WordStreamText({
  text,
  className = "",
}: {
  text: string
  className?: string
}) {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const targetRef = useRef(text)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number | null>(null)

  targetRef.current = text

  useEffect(() => {
    if (text.length < shownRef.current) {
      shownRef.current = 0
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
      const wps = behind > CATCHUP_BEHIND_CHARS ? CATCHUP_WORDS_PER_SECOND : WORDS_PER_SECOND
      const words = Math.max(1, Math.ceil((wps * dt) / 1000))
      const next = advanceByWords(targetRef.current, cur, words)
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

  if (!text || shown <= 0) return null

  const visible = text.slice(0, shown)
  const catchingUp = text.length - shown > CATCHUP_BEHIND_CHARS

  return (
    <span className={["word-stream-text", className].filter(Boolean).join(" ")}>
      {visible}
      {!catchingUp && shown < text.length ? (
        <span className="word-stream-cue" aria-hidden="true" />
      ) : null}
    </span>
  )
}

/** @deprecated Use WordStreamText — glyph scramble removed. */
export const GlyphStreamText = WordStreamText
