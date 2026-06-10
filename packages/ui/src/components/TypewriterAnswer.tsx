/**
 * TypewriterAnswer — sequential "printer" reveal for streaming agent answers.
 *
 * Reveals content block-by-block: prose types out, tables grow row-by-row,
 * dashboards build then appear. Incomplete structured tails show skeletons
 * (never raw markdown / JSON).
 */

import { useEffect, useMemo, useRef, useState } from "react"
import {
  availablePrintUnits,
  CATCHUP_MULTIPLIER,
  CATCHUP_UNITS_THRESHOLD,
  getStreamingSegments,
  revealFromUnits,
  snapProseTail,
  totalBlockUnits,
  UNITS_PER_SECOND,
} from "./answer-stream-reveal"
import { SmartAnswer } from "./SmartAnswer"
import { StructuredPendingBlock, TablePendingBlock } from "./StreamingBlocks"

export function TypewriterAnswer({
  text,
  streaming = false,
  compact = false,
}: {
  text: string
  streaming?: boolean
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
    let cancelled = false
    if (!streaming && unitsRef.current >= targetUnits) return

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
      if (streaming) {
        rafRef.current = requestAnimationFrame(tick)
      } else if (unitsRef.current < targetUnits) {
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
  }, [streaming, text, targetUnits])

  const blockReveal = useMemo(() => revealFromUnits(segments.blocks, units), [segments.blocks, units])

  const proseChars = Math.max(0, units - blockTotal)
  const proseTail =
    segments.layout.remainderKind === "prose" && segments.layout.remainder
      ? snapProseTail(segments.layout.remainder, proseChars, !streaming && units >= targetUnits)
      : ""

  const showStructuredPending =
    streaming &&
    (segments.layout.remainderKind === "fenced" || segments.layout.remainderKind === "table") &&
    segments.layout.remainder.length > 0 &&
    units >= blockTotal

  const caughtUp = units >= availablePrintUnits(segments)
  const waitingForMore =
    streaming &&
    caughtUp &&
    segments.layout.remainderKind !== "fenced" &&
    segments.layout.remainderKind !== "table"

  const finished = !streaming && units >= targetUnits

  if (finished) {
    return <SmartAnswer text={text} compact={compact} />
  }

  const hasBlockContent = segments.blocks.length > 0 && (blockReveal.doneCount > 0 || blockReveal.partial)
  const hasProse = proseTail.length > 0

  return (
    <div
      className={[
        compact ? "text-text-secondary text-[13px] leading-6 w-full min-w-0" : "text-text-secondary text-base leading-relaxed w-full min-w-0",
        "space-y-2",
      ].join(" ")}
    >
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
          {streaming || units < targetUnits ? (
            <span
              className={[
                "inline-block w-[2px] bg-accent/80 animate-pulse align-middle ml-0.5 -mt-1",
                compact ? "h-[13px]" : "h-[1em]",
              ].join(" ")}
              aria-hidden
            />
          ) : null}
        </div>
      ) : null}
      {showStructuredPending && segments.layout.remainderKind === "fenced" ? (
        <StructuredPendingBlock lang={segments.layout.fencedLang ?? "chart"} />
      ) : null}
      {showStructuredPending && segments.layout.remainderKind === "table" ? (
        <TablePendingBlock raw={segments.layout.remainder} />
      ) : null}
      {waitingForMore && !showStructuredPending ? (
        <div className="flex items-center gap-2 pt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-accent/70 animate-pulse shrink-0" />
          <span className="text-[12px] text-text-muted font-mono">Generating…</span>
        </div>
      ) : null}
    </div>
  )
}
