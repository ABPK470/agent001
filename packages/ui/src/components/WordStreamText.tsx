/**
 * Live streaming prose — sentence cadence, no glyph/char/word drip.
 *
 * Callers only pass plain prose (markdown-shaped tails are held elsewhere).
 * Completed sentences appear as units; an unfinished trailing clause flushes
 * after a short idle so the transcript never looks stuck mid-thought.
 */

import { useEffect, useRef, useState } from "react"

/** Wait this long after the last SSE growth before showing an unfinished clause. */
const TRAILING_FLUSH_MS = 160
/** When the buffer races ahead, flush unfinished remainder without waiting. */
const CATCHUP_BEHIND_CHARS = 120

/**
 * End index of the last completed sentence in `text` at or after `from`.
 * Sentence ends: `.` `!` `?` `…` (optionally followed by quotes/parens),
 * then whitespace or end-of-string. Also treats `\n\n` as a boundary.
 * Returns `from` when nothing complete is available yet.
 */
export function endOfLastCompleteSentence(text: string, from = 0): number {
  const start = Math.max(0, from)
  let last = start
  let i = start
  while (i < text.length) {
    if (text[i] === "\n" && text[i + 1] === "\n") {
      let j = i + 2
      while (j < text.length && /\s/.test(text[j]!)) j++
      last = j
      i = j
      continue
    }
    const ch = text[i]!
    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      let j = i + 1
      while (j < text.length && /["')\]]/.test(text[j]!)) j++
      if (j >= text.length || /\s/.test(text[j]!)) {
        while (j < text.length && /\s/.test(text[j]!)) j++
        last = j
        i = j
        continue
      }
    }
    i++
  }
  return last
}

/** @deprecated Prefer endOfLastCompleteSentence — word drip removed. */
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
  const textRef = useRef(text)
  const flushTimerRef = useRef<number | null>(null)

  textRef.current = text

  function commit(next: number): void {
    const capped = Math.min(Math.max(next, shownRef.current), textRef.current.length)
    if (capped === shownRef.current) return
    shownRef.current = capped
    setShown(capped)
  }

  function clearFlushTimer(): void {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }

  useEffect(() => {
    if (text.length < shownRef.current) {
      shownRef.current = 0
      setShown(0)
    }

    const complete = endOfLastCompleteSentence(text, 0)
    if (complete > shownRef.current) {
      commit(complete)
    }

    clearFlushTimer()
    const remainder = text.length - shownRef.current
    if (remainder <= 0) return

    if (remainder > CATCHUP_BEHIND_CHARS || complete >= text.length) {
      commit(text.length)
      return
    }

    // Unfinished clause — show after a brief idle (reads as a thought unit).
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      commit(textRef.current.length)
    }, TRAILING_FLUSH_MS)

    return () => {
      clearFlushTimer()
    }
  }, [text])

  useEffect(() => () => {
    clearFlushTimer()
  }, [])

  if (!text || shown <= 0) return null

  return (
    <span className={["word-stream-text", className].filter(Boolean).join(" ")}>
      {text.slice(0, shown)}
    </span>
  )
}

/** @deprecated Use WordStreamText — glyph scramble removed. */
export const GlyphStreamText = WordStreamText
