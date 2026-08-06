/**
 * Event Stream density strip — quiet volume over the active window.
 * Click / drag a range to focus; Esc or Clear restores the full window.
 * Flat pointer peers (no nested listeners).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import {
  buildEventStreamHistogram,
  histogramBucketCountForWidth,
  histogramBucketIndexAtRatio,
  histogramFocusFromBucketRange,
  type EventStreamHistogramBounds,
  type EventStreamHistogramModel,
} from "../../lib/event-stream-histogram"
import { useContainerSize } from "../../hooks/useContainerSize"
import type { LogEntry } from "../../types"

export type EventStreamHistogramFocus = {
  since: string
  until: string
}

type BrushState = {
  pointerId: number
  originIndex: number
  currentIndex: number
}

const PLOT_H = 36
const BAR_GAP = 1

function formatAxisTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function plotRatioFromClientX(svg: SVGSVGElement, clientX: number): number {
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}

export function EventStreamHistogram({
  logs,
  bounds,
  focus,
  onFocusChange,
}: {
  logs: readonly LogEntry[]
  bounds: EventStreamHistogramBounds
  focus: EventStreamHistogramFocus | null
  onFocusChange: (next: EventStreamHistogramFocus | null) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const brushRef = useRef<BrushState | null>(null)
  const [draftRange, setDraftRange] = useState<{ a: number; b: number } | null>(null)
  const [cursorIndex, setCursorIndex] = useState(0)
  const { width } = useContainerSize(rootRef)

  const bucketCount = histogramBucketCountForWidth(Math.max(0, width - 96))
  const model = useMemo(
    () => buildEventStreamHistogram(logs, bounds, bucketCount),
    [logs, bounds, bucketCount],
  )

  const selection = draftRange ?? focusSelection(model, focus)

  useEffect(() => {
    if (cursorIndex >= model.buckets.length) {
      setCursorIndex(Math.max(0, model.buckets.length - 1))
    }
  }, [cursorIndex, model.buckets.length])

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    const svg = svgRef.current
    if (!svg || model.buckets.length === 0) return
    const index = histogramBucketIndexAtRatio(
      model,
      plotRatioFromClientX(svg, event.clientX),
    )
    if (index < 0) return
    brushRef.current = {
      pointerId: event.pointerId,
      originIndex: index,
      currentIndex: index,
    }
    setDraftRange({ a: index, b: index })
    setCursorIndex(index)
    svg.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const brush = brushRef.current
    const svg = svgRef.current
    if (!brush || !svg || brush.pointerId !== event.pointerId) return
    const index = histogramBucketIndexAtRatio(
      model,
      plotRatioFromClientX(svg, event.clientX),
    )
    if (index < 0) return
    brush.currentIndex = index
    setDraftRange({ a: brush.originIndex, b: index })
    setCursorIndex(index)
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const brush = brushRef.current
    const svg = svgRef.current
    if (!brush || brush.pointerId !== event.pointerId) return
    brushRef.current = null
    if (svg?.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId)
    }
    const next = histogramFocusFromBucketRange(
      model,
      brush.originIndex,
      brush.currentIndex,
    )
    setDraftRange(null)
    onFocusChange(next)
  }

  function onPointerCancel(event: ReactPointerEvent<SVGSVGElement>) {
    const brush = brushRef.current
    if (!brush || brush.pointerId !== event.pointerId) return
    brushRef.current = null
    setDraftRange(null)
    const svg = svgRef.current
    if (svg?.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const n = model.buckets.length
    if (n === 0) return
    if (event.key === "Escape") {
      if (focus || draftRange) {
        event.preventDefault()
        setDraftRange(null)
        onFocusChange(null)
      }
      return
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      setCursorIndex((i) => Math.max(0, i - 1))
      return
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      setCursorIndex((i) => Math.min(n - 1, i + 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const next = histogramFocusFromBucketRange(model, cursorIndex, cursorIndex)
      onFocusChange(next)
    }
  }

  const max = Math.max(1, model.maxCount)
  const plotW = Math.max(1, width > 0 ? width - 96 : 320)

  return (
    <div
      ref={rootRef}
      className="event-stream-histogram"
      tabIndex={0}
      role="slider"
      aria-label="Event density over time"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, model.buckets.length - 1)}
      aria-valuenow={cursorIndex}
      onKeyDown={onKeyDown}
    >
      <div className="event-stream-histogram__rail">
        <span className="event-stream-histogram__axis" aria-hidden>
          {formatAxisTime(model.startMs)}
        </span>
        <svg
          ref={svgRef}
          className="event-stream-histogram__plot"
          viewBox={`0 0 ${plotW} ${PLOT_H}`}
          preserveAspectRatio="none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <line
            className="event-stream-histogram__baseline"
            x1={0}
            y1={PLOT_H - 0.5}
            x2={plotW}
            y2={PLOT_H - 0.5}
          />
          {selection && model.buckets.length > 0 ? (
            <rect
              className="event-stream-histogram__selection"
              x={(Math.min(selection.a, selection.b) / model.buckets.length) * plotW}
              y={0}
              width={
                ((Math.abs(selection.b - selection.a) + 1) / model.buckets.length) * plotW
              }
              height={PLOT_H}
            />
          ) : null}
          {model.buckets.map((bucket, index) => {
            const slot = plotW / model.buckets.length
            const barW = Math.max(1, slot - BAR_GAP)
            const x = index * slot + BAR_GAP / 2
            const h = bucket.count === 0 ? 0 : Math.max(2, (bucket.count / max) * (PLOT_H - 2))
            const y = PLOT_H - h
            const errH =
              bucket.errorCount === 0 || bucket.count === 0
                ? 0
                : Math.max(1, (bucket.errorCount / bucket.count) * h)
            return (
              <g key={`${bucket.startMs}-${index}`}>
                {bucket.count > 0 ? (
                  <rect
                    className="event-stream-histogram__bar"
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                  />
                ) : null}
                {errH > 0 ? (
                  <rect
                    className="event-stream-histogram__bar-error"
                    x={x}
                    y={y}
                    width={barW}
                    height={errH}
                  />
                ) : null}
              </g>
            )
          })}
        </svg>
        <span className="event-stream-histogram__axis" aria-hidden>
          {formatAxisTime(model.endMs)}
        </span>
      </div>
      {focus ? (
        <button
          type="button"
          className="event-stream-histogram__clear"
          onClick={() => onFocusChange(null)}
        >
          Clear range
        </button>
      ) : null}
    </div>
  )
}

function focusSelection(
  model: EventStreamHistogramModel,
  focus: EventStreamHistogramFocus | null,
): { a: number; b: number } | null {
  if (!focus || model.buckets.length === 0) return null
  const sinceMs = Date.parse(focus.since)
  const untilMs = Date.parse(focus.until)
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return null
  let a = -1
  let b = -1
  for (let i = 0; i < model.buckets.length; i += 1) {
    const bucket = model.buckets[i]!
    const overlaps = bucket.endMs > sinceMs && bucket.startMs < untilMs
    if (!overlaps) continue
    if (a < 0) a = i
    b = i
  }
  if (a < 0 || b < 0) return null
  return { a, b }
}
