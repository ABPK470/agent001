/**
 * TypewriterAnswer — streaming answer renderer with paced reveal.
 *
 * Network token delivery is bursty; we pace a local cursor so prose still
 * feels live. Structured blocks (tables, charts, dashboards) render through
 * SmartAnswer as soon as they are structurally complete — never as raw
 * markdown / JSON characters. In-progress structured tails show skeletons.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { joinStreamingParts, splitStreamingAnswer } from "./answer-stream-layout"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock, TablePendingBlock } from "./StreamingBlocks"

const BASE_CHARS_PER_SECOND = 220
const CATCHUP_MULTIPLIER = 5
const CATCHUP_THRESHOLD_CHARS = 120

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

  targetRef.current = text

  useEffect(() => {
    if (text.length < cursorRef.current) {
      cursorRef.current = text.length
      setRevealed(text.length)
    }
  }, [text])

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
        const cps =
          behind > CATCHUP_THRESHOLD_CHARS
            ? BASE_CHARS_PER_SECOND * CATCHUP_MULTIPLIER
            : BASE_CHARS_PER_SECOND
        const advance = Math.max(1, Math.ceil((cps * dt) / 1000))
        cursorRef.current = Math.min(target, cursorRef.current + advance)
        setRevealed(cursorRef.current)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      lastTickRef.current = null
      if (streaming) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
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

  const layout = useMemo(() => splitStreamingAnswer(text), [text])

  const proseTail = useMemo(() => {
    if (layout.remainderKind !== "prose" || !layout.remainder) return ""
    const proseStart = layout.committed ? layout.committed.length + 2 : 0
    const slice = layout.remainder.slice(0, Math.max(0, revealed - proseStart))
    const atEnd = !streaming && revealed >= text.length
    return snapToWordBoundary(slice, atEnd)
  }, [layout, revealed, streaming, text.length])

  const renderText = useMemo(
    () => joinStreamingParts(layout.committed, proseTail),
    [layout.committed, proseTail],
  )

  const showStructuredPending =
    streaming &&
    (layout.remainderKind === "fenced" || layout.remainderKind === "table") &&
    layout.remainder.length > 0

  const showProseCursor =
    streaming &&
    layout.remainderKind === "prose" &&
    (renderText.length > 0 || layout.remainder.length > 0)

  if (!streaming && revealed >= text.length) {
    return <SmartAnswer text={text} compact={compact} />
  }

  return (
    <div
      className={[
        compact ? "text-text-secondary text-[13px] leading-6 w-full min-w-0" : "text-text-secondary text-base leading-relaxed w-full min-w-0",
        "space-y-2",
      ].join(" ")}
    >
      {renderText ? <SmartAnswer text={renderText} streaming compact={compact} /> : null}
      {showStructuredPending && layout.remainderKind === "fenced" ? (
        <StructuredPendingBlock lang={layout.fencedLang ?? "text"} />
      ) : null}
      {showStructuredPending && layout.remainderKind === "table" ? (
        <TablePendingBlock raw={layout.remainder} />
      ) : null}
      {showProseCursor ? <StreamingCursor compact={compact} /> : null}
    </div>
  )
}

function StreamingCursor({ compact }: { compact?: boolean }) {
  return (
    <span
      className={[
        "inline-block w-[2px] bg-accent/75 animate-pulse align-middle",
        compact ? "h-[14px] ml-0.5" : "h-[1.1em] ml-0.5",
      ].join(" ")}
      aria-hidden
    />
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
