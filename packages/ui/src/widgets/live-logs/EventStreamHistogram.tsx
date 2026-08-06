/**
 * Event Stream density strip — lane-stacked volume over the active window.
 * Server buckets when available; client lensRows as fallback.
 * Brush focuses the list; Zoom re-fetches that ISO window.
 * Flat pointer peers (no nested listeners).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { api } from "../../client/index"
import { useContainerSize } from "../../hooks/useContainerSize"
import { EVENT_STREAM_EXCLUDE_TYPES } from "../../lib/event-stream-window"
import { eventStreamLanesDbPatterns } from "../../lib/event-stream-lane"
import {
  buildEventStreamHistogram,
  formatHistogramBoundPair,
  HISTOGRAM_STACK_ORDER,
  histogramBucketCountForWidth,
  histogramBucketIndexAtRatio,
  histogramFocusFromBucketRange,
  modelFromHistogramApi,
  type EventStreamHistogramApiResult,
  type EventStreamHistogramBounds,
  type EventStreamHistogramModel,
} from "../../lib/event-stream-histogram"
import type { EventStreamLane } from "../../lib/event-stream-lane"
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

const PLOT_H = 40
const BAR_GAP = 1

function plotRatioFromClientX(svg: SVGSVGElement, clientX: number): number {
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}

export function EventStreamHistogram({
  lensRows,
  bounds,
  focus,
  onFocusChange,
  onZoomToFocus,
  listVisibleCount,
  typeFilters,
  errorsOnly,
  searchText,
}: {
  /** Pre-brush filtered events — client fallback + list parity for filters. */
  lensRows: readonly LogEntry[]
  bounds: EventStreamHistogramBounds
  focus: EventStreamHistogramFocus | null
  onFocusChange: (next: EventStreamHistogramFocus | null) => void
  onZoomToFocus: (focus: EventStreamHistogramFocus) => void
  listVisibleCount: number
  typeFilters: ReadonlySet<EventStreamLane>
  errorsOnly: boolean
  searchText: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const brushRef = useRef<BrushState | null>(null)
  const [draftRange, setDraftRange] = useState<{ a: number; b: number } | null>(null)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [serverModel, setServerModel] = useState<EventStreamHistogramModel | null>(null)
  const { width } = useContainerSize(rootRef)

  const bucketCount = histogramBucketCountForWidth(Math.max(0, width - 96))
  // Live windows have no until — refresh on a quiet cadence so we don't
  // re-fetch the histogram on every paint.
  const [liveUntil, setLiveUntil] = useState(() => new Date().toISOString())
  useEffect(() => {
    if (bounds.until) return
    setLiveUntil(new Date().toISOString())
    const id = window.setInterval(() => {
      setLiveUntil(new Date().toISOString())
    }, 15_000)
    return () => window.clearInterval(id)
  }, [bounds.until, bounds.since])
  const until = bounds.until ?? liveUntil
  const typeKey = useMemo(
    () => [...typeFilters].sort().join(","),
    [typeFilters],
  )

  const clientModel = useMemo(
    () => buildEventStreamHistogram(lensRows, { since: bounds.since, until }, bucketCount),
    [lensRows, bounds.since, until, bucketCount],
  )

  useEffect(() => {
    let cancelled = false
    const patterns = eventStreamLanesDbPatterns(typeFilters)
    const timer = window.setTimeout(() => {
      void api
        .eventsHistogram({
          since: bounds.since,
          until,
          buckets: bucketCount,
          q: searchText.trim().length >= 2 ? searchText : undefined,
          exclude_types: [...EVENT_STREAM_EXCLUDE_TYPES],
          type_patterns: patterns,
          errors_only: errorsOnly,
        })
        .then((res) => {
          if (cancelled) return
          setServerModel(modelFromHistogramApi(res as EventStreamHistogramApiResult))
        })
        .catch((err: unknown) => {
          console.error("[mia] events histogram", err)
          if (!cancelled) setServerModel(null)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    bounds.since,
    until,
    bucketCount,
    searchText,
    errorsOnly,
    typeKey,
    typeFilters,
  ])

  const model = serverModel ?? clientModel
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

  function onDoubleClick() {
    setDraftRange(null)
    onFocusChange(null)
  }

  const max = Math.max(1, model.maxCount)
  const plotW = Math.max(1, width > 0 ? width - 96 : 320)
  const lensTotal = serverModel?.totalCount ?? clientModel.totalCount
  const axisLabels = formatHistogramBoundPair(model.startMs, model.endMs)

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
      <div className="event-stream-histogram__meta">
        <span className="event-stream-histogram__count">
          {focus
            ? `Showing ${listVisibleCount.toLocaleString()} of ${lensTotal.toLocaleString()} events`
            : `Showing ${lensTotal.toLocaleString()} events`}
        </span>
        {model.truncated ? (
          <span className="event-stream-histogram__truncated" title="Density scan hit the server cap">
            Histogram capped — denser than shown may exist
          </span>
        ) : null}
      </div>
      <div className="event-stream-histogram__rail">
        <span className="event-stream-histogram__axis" aria-hidden>
          {axisLabels.start}
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
          onDoubleClick={onDoubleClick}
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
            let yCursor = PLOT_H
            const segments: Array<{ lane: EventStreamLane; height: number; y: number }> = []
            if (bucket.count > 0) {
              for (const lane of HISTOGRAM_STACK_ORDER) {
                const n = bucket.byLane[lane] ?? 0
                if (n <= 0) continue
                const segH = Math.max(1, (n / bucket.count) * h)
                yCursor -= segH
                segments.push({ lane, height: segH, y: yCursor })
              }
            }
            return (
              <g key={`${bucket.startMs}-${index}`}>
                {segments.map((seg) => (
                  <rect
                    key={seg.lane}
                    className={`event-stream-histogram__bar event-stream-histogram__bar--${seg.lane}`}
                    x={x}
                    y={seg.y}
                    width={barW}
                    height={seg.height}
                  />
                ))}
              </g>
            )
          })}
        </svg>
        <span className="event-stream-histogram__axis" aria-hidden>
          {axisLabels.end}
        </span>
      </div>
      {focus ? (
        <div className="event-stream-histogram__actions">
          <button
            type="button"
            className="event-stream-histogram__action"
            onClick={() => onZoomToFocus(focus)}
          >
            Zoom to selection
          </button>
          <button
            type="button"
            className="event-stream-histogram__action"
            onClick={() => onFocusChange(null)}
          >
            Clear range
          </button>
        </div>
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
