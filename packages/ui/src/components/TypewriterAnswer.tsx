/**
 * TypewriterAnswer — streaming answer renderer with paced reveal.
 *
 * We can't rely on the network delivering tokens at a smooth cadence:
 *   - Some upstream LLMs (Databricks/Copilot proxies) buffer and emit
 *     large content chunks in bursts, so the UI would otherwise jump
 *     from empty to a full paragraph in one frame.
 *   - TCP buffering, dev proxies, and browser EventSource batching can
 *     turn a token-by-token stream into a single arrival.
 *
 * Solution: keep a local cursor that advances at a controlled pace
 * (rAF-driven, characters per frame) towards the latest received text.
 * When new text arrives we don't render it directly — we move the
 * target, and the cursor catches up smoothly. This guarantees visible
 * word-by-word streaming regardless of how the network delivers chunks.
 *
 * Once streaming ends, we hand off to SmartAnswer for full markdown.
 */

import { useEffect, useRef, useState } from "react"
import { SmartAnswer } from "./SmartAnswer"

// Target reveal rate. ~36 wpm × 5 chars/word ≈ 180 cps — comfortable reading
// pace that still feels live. We let the cursor catch up faster when far
// behind so the UI never falls minutes behind a giant burst.
const BASE_CHARS_PER_SECOND = 180
const CATCHUP_MULTIPLIER = 4
const CATCHUP_THRESHOLD_CHARS = 160

export function TypewriterAnswer({
  text,
  streaming = false,
  compact = false,
}: {
  text: string
  streaming?: boolean
  compact?: boolean
}) {
  const [revealed, setRevealed] = useState(0)
  const cursorRef = useRef(0)
  const lastTickRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const targetRef = useRef(text)

  // Always observe the latest text from the rAF loop without re-subscribing.
  targetRef.current = text

  // Reset when text shrinks (new run / stream.reset cleared the buffer).
  useEffect(() => {
    if (text.length < cursorRef.current) {
      cursorRef.current = text.length
      setRevealed(text.length)
    }
  }, [text])

  // Run the cursor while we're either still receiving OR still catching up.
  // The dependency on `text` re-arms the loop when more text arrives after
  // the cursor had idled, and on `streaming` flipping to false (so we still
  // animate the tail of the final answer instead of snapping it in).
  useEffect(() => {
    let cancelled = false
    if (!streaming && cursorRef.current >= text.length) return

    const tick = (now: number) => {
      if (cancelled) return
      const target = targetRef.current.length
      if (cursorRef.current < target) {
        const last = lastTickRef.current ?? now
        const dt = Math.min(now - last, 100)
        lastTickRef.current = now
        const behind = target - cursorRef.current
        const cps = behind > CATCHUP_THRESHOLD_CHARS
          ? BASE_CHARS_PER_SECOND * CATCHUP_MULTIPLIER
          : BASE_CHARS_PER_SECOND
        const advance = Math.max(1, Math.ceil((cps * dt) / 1000))
        cursorRef.current = Math.min(target, cursorRef.current + advance)
        setRevealed(cursorRef.current)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      // Caught up.
      lastTickRef.current = null
      if (streaming) {
        // More text may arrive — keep the loop alive idling.
        rafRef.current = requestAnimationFrame(tick)
      } else {
        // Streaming ended and we've revealed everything — done.
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTickRef.current = null
    }
  }, [streaming, text])

  if (!streaming && revealed >= text.length) {
    return <SmartAnswer text={text} compact={compact} />
  }

  const slice = text.slice(0, revealed)
  const display = snapToWordBoundary(slice, !streaming && revealed >= text.length)

  return (
    <div className="text-text-secondary text-base leading-relaxed w-full min-w-0 space-y-2">
      <div className="whitespace-pre-wrap break-words">{display}</div>
    </div>
  )
}

function snapToWordBoundary(s: string, atEnd: boolean): string {
  if (!s) return ""
  if (atEnd) return s
  if (/\s$/.test(s)) return s
  const lastWhitespace = s.search(/\s[^\s]*$/)
  if (lastWhitespace < 0) return s
  return s.slice(0, lastWhitespace + 1)
}
