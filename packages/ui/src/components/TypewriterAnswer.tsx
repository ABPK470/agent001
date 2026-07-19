/**
 * TypewriterAnswer — answer reveal for agent responses.
 *
 * Live SSE streaming renders committed markdown blocks immediately and
 * streams the volatile tail as ASCII glyphs (no cursor). Completed
 * answers use block-by-block reveal, then SmartAnswer.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import {
  availablePrintUnits,
  CATCHUP_MULTIPLIER,
  CATCHUP_UNITS_THRESHOLD,
  getLiveStreamingRenderParts,
  getStreamingSegments,
  revealFromUnits,
  snapProseTail,
  totalBlockUnits,
  UNITS_PER_SECOND,
} from "./answer-stream-reveal"
import { GlyphStreamText } from "./GlyphStreamText"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock, TablePendingBlock } from "./StreamingBlocks"

const bodyClass = (compact: boolean) =>
  compact
    ? "text-text-secondary text-[15px] leading-6 w-full min-w-0"
    : "text-text-secondary text-base leading-relaxed w-full min-w-0"

/** Live stream — formatted committed blocks + quiet tail for in-flight prose. */
function StreamingLiveAnswer({ text, compact }: { text: string; compact: boolean }) {
  const { blocks, glyphTail, layout } = useMemo(() => getLiveStreamingRenderParts(text), [text])

  const hasBlockContent = blocks.length > 0
  const hasGlyphTail = glyphTail.length > 0
  const showStructuredPending =
    (layout.remainderKind === "fenced" || layout.remainderKind === "table") &&
    layout.remainder.length > 0

  // Match SmartAnswer's settled spacing so live → done does not reflow gaps.
  return (
    <div className={[bodyClass(compact), "space-y-3"].join(" ")}>
      {hasBlockContent ? (
        <SmartAnswer blocks={blocks} compact={compact} streaming />
      ) : null}
      {hasGlyphTail ? (
        <div className="whitespace-pre-wrap break-words">
          <GlyphStreamText text={glyphTail} />
        </div>
      ) : null}
      {showStructuredPending && layout.remainderKind === "fenced" ? (
        <StructuredPendingBlock lang={layout.fencedLang ?? "chart"} />
      ) : null}
      {showStructuredPending && layout.remainderKind === "table" ? (
        <TablePendingBlock raw={layout.remainder} />
      ) : null}
    </div>
  )
}

function TypewriterRevealAnswer({
  text,
  compact = false,
}: {
  text: string
  compact?: boolean
}) {
  const [units, setUnits] = useState(0)
  const unitsRef = useRef(0)
  const lastTickRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const targetTextRef = useRef(text)
  const prevLenRef = useRef(text.length)

  targetTextRef.current = text

  const segments = useMemo(() => getStreamingSegments(text), [text])
  const blockTotal = useMemo(() => totalBlockUnits(segments.blocks), [segments.blocks])
  const targetUnits = useMemo(() => availablePrintUnits(segments), [segments])

  useEffect(() => {
    if (text.length < prevLenRef.current) {
      unitsRef.current = 0
      setUnits(0)
    }
    prevLenRef.current = text.length
  }, [text])

  useEffect(() => {
    const target = availablePrintUnits(getStreamingSegments(text))
    if (unitsRef.current !== target) {
      unitsRef.current = target
      setUnits(target)
    }
  }, [text])

  useEffect(() => {
    let cancelled = false
    if (unitsRef.current >= targetUnits) return

    const tick = (now: number) => {
      if (cancelled) return
      const target = availablePrintUnits(getStreamingSegments(targetTextRef.current))
      if (unitsRef.current < target) {
        const last = lastTickRef.current ?? now
        const dt = Math.min(now - last, 100)
        lastTickRef.current = now
        const behind = target - unitsRef.current
        const ups =
          behind > CATCHUP_UNITS_THRESHOLD
            ? UNITS_PER_SECOND * CATCHUP_MULTIPLIER
            : UNITS_PER_SECOND
        const advance = Math.max(1, Math.ceil((ups * dt) / 1000))
        unitsRef.current = Math.min(target, unitsRef.current + advance)
        setUnits(unitsRef.current)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      lastTickRef.current = null
      if (unitsRef.current < targetUnits) {
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
  }, [text, targetUnits])

  const blockReveal = useMemo(() => revealFromUnits(segments.blocks, units), [segments.blocks, units])

  const proseChars = Math.max(0, units - blockTotal)
  const proseTail =
    segments.layout.remainderKind === "prose" && segments.layout.remainder
      ? snapProseTail(segments.layout.remainder, proseChars, units >= targetUnits)
      : ""

  const showStructuredPending =
    (segments.layout.remainderKind === "fenced" || segments.layout.remainderKind === "table") &&
    segments.layout.remainder.length > 0 &&
    units >= blockTotal

  const finished = units >= targetUnits

  if (finished) {
    return <SmartAnswer text={text} compact={compact} />
  }

  const hasBlockContent = segments.blocks.length > 0 && (blockReveal.doneCount > 0 || blockReveal.partial)
  const hasProse = proseTail.length > 0

  return (
    <div className={[bodyClass(compact), "space-y-3"].join(" ")}>
      {hasBlockContent ? (
        <SmartAnswer
          blocks={segments.blocks}
          reveal={blockReveal}
          streaming
          compact={compact}
        />
      ) : null}
      {hasProse ? (
        <div>
          <SmartAnswer text={proseTail} streaming compact={compact} />
        </div>
      ) : null}
      {showStructuredPending && segments.layout.remainderKind === "fenced" ? (
        <StructuredPendingBlock lang={segments.layout.fencedLang ?? "chart"} />
      ) : null}
      {showStructuredPending && segments.layout.remainderKind === "table" ? (
        <TablePendingBlock raw={segments.layout.remainder} />
      ) : null}
    </div>
  )
}

export function TypewriterAnswer({
  text,
  streaming = false,
  compact = false,
}: {
  text: string
  streaming?: boolean
  compact?: boolean
}) {
  // Preserve the component across the live → completed transition. A streamed
  // answer is already fully visible; starting TypewriterRevealAnswer from zero
  // at completion would make it disappear and re-type. Historical answers,
  // which mount completed and were never streamed in this session, still use
  // the deliberate reveal.
  const hasStreamedRef = useRef(streaming)
  if (streaming) hasStreamedRef.current = true

  if (streaming) {
    return <StreamingLiveAnswer text={text} compact={compact} />
  }
  if (hasStreamedRef.current) {
    return <SmartAnswer text={text} compact={compact} />
  }
  return <TypewriterRevealAnswer text={text} compact={compact} />
}
