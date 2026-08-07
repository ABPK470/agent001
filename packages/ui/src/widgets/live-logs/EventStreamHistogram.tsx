/**
 * Event Stream density strip — lane-stacked volume over the active window.
 * Server buckets when available; client lensRows as fallback.
 * Brush focuses the list; Zoom re-fetches that ISO window.
 *
 * Interaction: padded hit target · paint / edge-resize / move · ←→ nudge.
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
import {
  applyHistogramBrushMove,
  applyHistogramBrushResize,
  buildEventStreamHistogram,
  formatHistogramBoundPair,
  HISTOGRAM_STACK_ORDER,
  histogramBucketCountForWidth,
  histogramBucketIndexAtRatio,
  histogramEdgeHitBuckets,
  histogramFocusFromBucketRange,
  modelFromHistogramApi,
  nudgeHistogramSelection,
  resolveHistogramBrushKind,
  resizeHistogramSelectionEdge,
  type EventStreamHistogramApiResult,
  type EventStreamHistogramBounds,
  type EventStreamHistogramModel,
  type HistogramBrushKind,
  type HistogramSelectionRange,
} from "../../lib/event-stream-histogram"
import { EVENT_STREAM_EXCLUDE_TYPES } from "../../lib/event-stream-window"
import {
  eventStreamLanesDbPatterns,
  type EventStreamLane,
} from "../../lib/event-stream-lane"
import type { LogEntry } from "../../types"

export type EventStreamHistogramFocus = {
  since: string
  until: string
}

type BrushState = {
  pointerId: number
  kind: HistogramBrushKind
  originIndex: number
  currentIndex: number
  startLo: number
  startHi: number
  grabIndex: number
}

const PLOT_H = 40
const BAR_GAP = 1

function plotRatioFromClientX(plotEl: Element, clientX: number): number {
  const rect = plotEl.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
}

function commitFocus(
  model: EventStreamHistogramModel,
  range: HistogramSelectionRange,
  onFocusChange: (next: EventStreamHistogramFocus | null) => void,
) {
  onFocusChange(histogramFocusFromBucketRange(model, range.a, range.b))
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
  const plotRef = useRef<HTMLDivElement>(null)
  const brushRef = useRef<BrushState | null>(null)
  const [draftRange, setDraftRange] = useState<HistogramSelectionRange | null>(null)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [hoverKind, setHoverKind] = useState<HistogramBrushKind | null>(null)
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
  const plotW = Math.max(1, width > 0 ? width - 96 : 320)
  const edgeBuckets = histogramEdgeHitBuckets(model.buckets.length, plotW)

  useEffect(() => {
    if (cursorIndex >= model.buckets.length) {
      setCursorIndex(Math.max(0, model.buckets.length - 1))
    }
  }, [cursorIndex, model.buckets.length])

  function indexAtClientX(clientX: number): number {
    const plot = plotRef.current
    if (!plot || model.buckets.length === 0) return -1
    return histogramBucketIndexAtRatio(model, plotRatioFromClientX(plot, clientX))
  }

  function brushKindAtIndex(index: number): HistogramBrushKind {
    return resolveHistogramBrushKind(
      index,
      selection,
      model.buckets.length,
      edgeBuckets,
    )
  }

  function rangeFromBrush(brush: BrushState): HistogramSelectionRange {
    if (brush.kind === "paint") {
      return {
        a: Math.min(brush.originIndex, brush.currentIndex),
        b: Math.max(brush.originIndex, brush.currentIndex),
      }
    }
    if (brush.kind === "move") {
      return applyHistogramBrushMove(
        brush.startLo,
        brush.startHi,
        brush.grabIndex,
        brush.currentIndex,
        model.buckets.length,
      )
    }
    if (brush.kind === "resize-start") {
      return applyHistogramBrushResize(
        "start",
        brush.startLo,
        brush.startHi,
        brush.currentIndex,
        model.buckets.length,
      )
    }
    return applyHistogramBrushResize(
      "end",
      brush.startLo,
      brush.startHi,
      brush.currentIndex,
      model.buckets.length,
    )
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const hit = event.currentTarget
    if (model.buckets.length === 0) return
    const index = indexAtClientX(event.clientX)
    if (index < 0) return
    const lo = selection ? Math.min(selection.a, selection.b) : index
    const hi = selection ? Math.max(selection.a, selection.b) : index
    const kind = brushKindAtIndex(index)
    brushRef.current = {
      pointerId: event.pointerId,
      kind,
      originIndex: index,
      currentIndex: index,
      startLo: lo,
      startHi: hi,
      grabIndex: index,
    }
    setDraftRange(rangeFromBrush(brushRef.current))
    setCursorIndex(index)
    setHoverKind(kind)
    hit.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const brush = brushRef.current
    if (!brush || brush.pointerId !== event.pointerId) {
      const index = indexAtClientX(event.clientX)
      if (index < 0) {
        setHoverKind(null)
        return
      }
      setHoverKind(brushKindAtIndex(index))
      return
    }
    const index = indexAtClientX(event.clientX)
    if (index < 0) return
    brush.currentIndex = index
    setDraftRange(rangeFromBrush(brush))
    setCursorIndex(index)
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const brush = brushRef.current
    if (!brush || brush.pointerId !== event.pointerId) return
    brushRef.current = null
    const hit = event.currentTarget
    if (hit.hasPointerCapture(event.pointerId)) {
      hit.releasePointerCapture(event.pointerId)
    }
    const range = rangeFromBrush(brush)
    setDraftRange(null)
    commitFocus(model, range, onFocusChange)
    setHoverKind(null)
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const brush = brushRef.current
    if (!brush || brush.pointerId !== event.pointerId) return
    brushRef.current = null
    setDraftRange(null)
    setHoverKind(null)
    const hit = event.currentTarget
    if (hit.hasPointerCapture(event.pointerId)) {
      hit.releasePointerCapture(event.pointerId)
    }
  }

  function onPointerLeave() {
    if (!brushRef.current) setHoverKind(null)
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

    const active = selection
    if (active && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault()
      const delta = event.key === "ArrowLeft" ? -1 : 1
      // ←→ nudge window · Shift+←/→ move start/end edge
      const next = event.shiftKey
        ? resizeHistogramSelectionEdge(
            active,
            n,
            event.key === "ArrowLeft" ? "start" : "end",
            delta,
          )
        : nudgeHistogramSelection(active, n, delta)
      if (!next) return
      setDraftRange(null)
      commitFocus(model, next, onFocusChange)
      setCursorIndex(event.key === "ArrowLeft" ? next.a : next.b)
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
      if (focus) {
        onZoomToFocus(focus)
        return
      }
      const next = histogramFocusFromBucketRange(model, cursorIndex, cursorIndex)
      onFocusChange(next)
    }
  }

  function onDoubleClick() {
    setDraftRange(null)
    onFocusChange(null)
  }

  const max = Math.max(1, model.maxCount)
  const lensTotal = serverModel?.totalCount ?? clientModel.totalCount
  const axisLabels = formatHistogramBoundPair(model.startMs, model.endMs)
  const selLo = selection ? Math.min(selection.a, selection.b) : -1
  const selHi = selection ? Math.max(selection.a, selection.b) : -1
  const selX = selection && model.buckets.length > 0
    ? (selLo / model.buckets.length) * plotW
    : 0
  const selW = selection && model.buckets.length > 0
    ? ((selHi - selLo + 1) / model.buckets.length) * plotW
    : 0

  const hitCursor =
    hoverKind === "resize-start" || hoverKind === "resize-end"
      ? "col-resize"
      : hoverKind === "move"
        ? draftRange ? "grabbing" : "grab"
        : "crosshair"

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
        <div
          ref={plotRef}
          className="event-stream-histogram__plot-hit"
          style={{ cursor: hitCursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
        >
          <svg
            className="event-stream-histogram__plot"
            viewBox={`0 0 ${plotW} ${PLOT_H}`}
            preserveAspectRatio="none"
            aria-hidden
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
                x={selX}
                y={0}
                width={selW}
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
                  const count = bucket.byLane[lane] ?? 0
                  if (count <= 0) continue
                  const segH = Math.max(1, (count / bucket.count) * h)
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
            {selection && model.buckets.length > 0 ? (
              <>
                <rect
                  className="event-stream-histogram__handle"
                  x={selX - 1}
                  y={0}
                  width={2}
                  height={PLOT_H}
                />
                <rect
                  className="event-stream-histogram__handle"
                  x={selX + selW - 1}
                  y={0}
                  width={2}
                  height={PLOT_H}
                />
              </>
            ) : null}
          </svg>
        </div>
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
): HistogramSelectionRange | null {
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
