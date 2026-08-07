/**
 * Event Stream — Datadog-style live tail + time-bounded history.
 *
 * One stream (no separate "from database" pane):
 *   - One Filters sheet: quick range + From/Until + type + severity (Sync History dialect)
 *   - Scroll up → older pages within the range
 *   - SSE appends in Live; fixed ranges show "N new → Jump to live"
 *   - Search / type filters apply within the selected time window only
 */

import { ArrowDown, ChevronRight, Filter, Pause, Play, Radio, SlidersHorizontal } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { DateField } from "../components/DateField"
import { EmptyState } from "../components/EmptyState"
import type { ReviewTreeKeyboardNode } from "../components/review/review-tree-keyboard"
import { VirtualList, type VirtualListHandle } from "../components/VirtualList"
import { useOperatorSurfaceArmed } from "../hooks/useOperatorSurfaceArmed"
import { useReviewTreeKeyboard } from "../hooks/useReviewTreeKeyboard"
import {
  ActiveFilterChips,
  FilterChoiceGrid,
  FilterField,
  FilterSheet,
  type ActiveFilterChipModel,
} from "../components/FilterSheet"
import { SqlTraceFromEventData } from "./sync/trace/SqlTrace"
import { JsonViewer } from "../components/JsonViewer"
import { useContainerSize } from "../hooks/useContainerSize"
import {
  type EventStreamRange,
  logInWindow,
  resolveWindowBounds,
  useEventStreamData,
} from "../hooks/useEventStreamData"
import { useWidgetInstance } from "../app/workspace/widget-instance"
import { formatLogEntry } from "../state/store"
import type { LogEntry } from "../types"
import { isSyncSqlEventType } from "./sync/trace/sync-sql-trace"
import { operationStatusPill } from "../lib/status-callout"
import { WIDGET_ICONS } from "./widget-icons"
import {
  WIDGET_LOG_SCROLL_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WIDGET_REVIEW_CONTROLS_CLASS,
  WIDGET_REVIEW_CONTROLS_INSET_CLASS,
  WidgetToolbar,
  WidgetToolbarCount,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "./widget-toolbar"
import { logMatchesFilters } from "../lib/event-stream-filter"
import { formatHistogramBoundPair } from "../lib/event-stream-histogram"
import { formatEventStreamRowTime } from "../lib/event-stream-time"
import {
  EVENT_STREAM_LANES,
  eventStreamFilterTypeClass,
  eventStreamLanesDbPatterns,
  eventStreamTypeClass,
  type EventStreamEventType,
} from "../lib/event-stream-lane"
import {
  readEventStreamPrefs,
  writeEventStreamPrefs,
} from "../lib/event-stream-prefs"
import {
  EventStreamHistogram,
  type EventStreamHistogramFocus,
} from "./live-logs/EventStreamHistogram"

type EventType = EventStreamEventType

const TYPE_OPTIONS = EVENT_STREAM_LANES.map((value) => ({
  value,
  label: value,
  className: eventStreamFilterTypeClass(value),
}))

const QUICK_RANGES: { id: EventStreamRange; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
]

function eventStreamRowKey(log: LogEntry, index: number): string {
  return `${log.timestamp}|${log.eventName ?? ""}|${log.type}|${index}`
}

function eventStreamHasPayload(log: LogEntry): boolean {
  return Boolean(log.data && Object.keys(log.data).length > 0)
}

export function LiveLogs() {
  const instance = useWidgetInstance()
  const tileId = instance?.widgetId ?? null
  const surfaceArmed = useOperatorSurfaceArmed()
  const initialPrefs = useMemo(() => readEventStreamPrefs(tileId), [tileId])

  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [typeFilters, setTypeFilters] = useState<Set<EventType>>(
    () => new Set(initialPrefs.typeFilters),
  )
  const [errorsOnly, setErrorsOnly] = useState(() => initialPrefs.errorsOnly)
  const [searchText, setSearchText] = useState(() => initialPrefs.searchText)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [histogramFocus, setHistogramFocus] = useState<EventStreamHistogramFocus | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const listRef = useRef<VirtualListHandle>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const {
    entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    window: timeWindow,
    setQuickRange,
    setFromDate,
    setToDate,
    clearCustomDates,
    zoomToIsoRange,
    followLive,
  } = useEventStreamData({ paused, initialWindow: initialPrefs.window })

  // Persist lens across view switches (unmount). Pause/sheet open stay ephemeral.
  useEffect(() => {
    writeEventStreamPrefs(tileId, {
      typeFilters: [...typeFilters],
      errorsOnly,
      searchText,
      window: timeWindow,
    })
  }, [tileId, typeFilters, errorsOnly, searchText, timeWindow])

  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 860
  const tiny = rootWidth > 0 && rootWidth < 480

  // Deep search within the selected time window when the loaded page has no hits.
  const [searchHits, setSearchHits] = useState<LogEntry[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const windowBounds = useMemo(() => resolveWindowBounds(timeWindow), [timeWindow])

  const filteredForWindow = useMemo(
    () =>
      entries.filter(
        (l) =>
          logInWindow(l.timestamp, windowBounds) &&
          logMatchesFilters(l, typeFilters, errorsOnly, searchText),
      ),
    [entries, windowBounds, typeFilters, errorsOnly, searchText],
  )

  const searchActive = searchText.trim().length >= 2 || typeFilters.size > 0 || errorsOnly

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearchHits([])
    if (!searchActive) return
    if (filteredForWindow.length > 0) return

    searchTimer.current = setTimeout(() => {
      const q = searchText.trim()
      const typePatterns = eventStreamLanesDbPatterns(typeFilters)
      if (q.length < 2 && !typePatterns && !errorsOnly) return
      setSearching(true)
      void api
        .searchEvents(q.length >= 2 ? q : "", {
          type_patterns: errorsOnly ? ["%.failed", "%error%"] : typePatterns,
          limit: 300,
          since: windowBounds.since,
          until: windowBounds.until,
        })
        .then((res) => {
          const mapped: LogEntry[] = []
          for (const event of res.events) {
            if (!logInWindow(event.timestamp, windowBounds)) continue
            const entry = formatLogEntry(event.type, event.data ?? {}, event.timestamp)
            if (entry) mapped.push(entry)
          }
          setSearchHits(mapped.reverse())
        })
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false)).catch((err: unknown) => { console.error("[mia]", err) })
    }, 500)

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchActive, searchText, typeFilters, errorsOnly, filteredForWindow.length, windowBounds])

  const searchOnly = useMemo(() => {
    if (filteredForWindow.length > 0 || searchHits.length === 0) return []
    const liveKeys = new Set(entries.map((l) => `${l.eventName}\0${l.timestamp}\0${l.message}`))
    return searchHits.filter(
      (l) =>
        logInWindow(l.timestamp, windowBounds) &&
        !liveKeys.has(`${l.eventName}\0${l.timestamp}\0${l.message}`) &&
        logMatchesFilters(l, typeFilters, errorsOnly, searchText),
    )
  }, [filteredForWindow.length, searchHits, entries, windowBounds, typeFilters, errorsOnly, searchText])

  const lensRows = useMemo(
    () => (filteredForWindow.length > 0 ? filteredForWindow : searchOnly),
    [filteredForWindow, searchOnly],
  )

  const displayRows = useMemo(() => {
    if (!histogramFocus) return lensRows
    return lensRows.filter((l) =>
      logInWindow(l.timestamp, {
        since: histogramFocus.since,
        until: histogramFocus.until,
      }),
    )
  }, [lensRows, histogramFocus])

  const displayRowsRef = useRef(displayRows)
  displayRowsRef.current = displayRows

  useEffect(() => {
    if (autoScroll && !paused && followLive) {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [displayRows, autoScroll, paused, followLive])

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
    if (el.scrollTop < 80) loadOlder()
  }

  /** Live + scrolled up: pin to tip. Do not reload — entries are already here. */
  function scrollToLatest() {
    setAutoScroll(true)
    setHistogramFocus(null)
    const rows = displayRowsRef.current
    const last = rows.length - 1
    if (last >= 0) {
      const row = rows[last]!
      setSelectedKey(eventStreamRowKey(row, last))
      listRef.current?.scrollToIndex(last, { align: "end" })
    }
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Becoming the armed surface (tile focus or peek) opens at the live tip.
  const wasArmedRef = useRef(false)
  useEffect(() => {
    if (surfaceArmed && !wasArmedRef.current) {
      scrollToLatest()
    }
    wasArmedRef.current = surfaceArmed
  }, [surfaceArmed])

  /** Paused / historical window: resume live feed (reload) then pin. */
  function resumeLiveFeed() {
    setPaused(false)
    setAutoScroll(true)
    setHistogramFocus(null)
    jumpToLive()
  }

  const onQuickRange = useCallback(
    (next: EventStreamRange) => {
      setPaused(false)
      setAutoScroll(true)
      setHistogramFocus(null)
      setQuickRange(next)
    },
    [setQuickRange],
  )

  const showEmpty =
    !loading &&
    !searching &&
    displayRows.length === 0 &&
    (searchActive || entries.length === 0 || Boolean(histogramFocus))

  const keyboardNodes = useMemo((): ReviewTreeKeyboardNode[] => {
    return displayRows.map((log, index) => ({
      scopeId: eventStreamRowKey(log, index),
      parentScopeId: null,
      hasChildren: eventStreamHasPayload(log),
      flatIndex: index,
    }))
  }, [displayRows])

  const isKeyboardNodeFolded = useCallback(
    (node: ReviewTreeKeyboardNode) => !expandedKeys.has(node.scopeId),
    [expandedKeys],
  )

  const onKeyboardToggleFold = useCallback((scopeId: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(scopeId)) next.delete(scopeId)
      else next.add(scopeId)
      return next
    })
  }, [])

  // Claim while armed (focused tile or peek) — `/` must work even on an empty list.
  useReviewTreeKeyboard({
    enabled: surfaceArmed,
    surfaceId: "live-logs",
    nodes: keyboardNodes,
    selectedScopeId: selectedKey,
    isFolded: isKeyboardNodeFolded,
    onSelect: setSelectedKey,
    onToggleFold: onKeyboardToggleFold,
    listRef,
    onOpenSearch: () => searchInputRef.current?.focus(),
    onEnd: scrollToLatest,
  })

  const hasIsoZoom = Boolean(timeWindow.sinceIso)
  const hasCustomDates = Boolean(timeWindow.from || timeWindow.to)
  const timeFiltered =
    hasIsoZoom || hasCustomDates || timeWindow.range !== "live"
  const filtersActive = typeFilters.size > 0 || errorsOnly || timeFiltered
  const activeFilterCount =
    typeFilters.size
    + (errorsOnly ? 1 : 0)
    + (hasIsoZoom
      ? 1
      : hasCustomDates
        ? (timeWindow.from ? 1 : 0) + (timeWindow.to ? 1 : 0)
        : timeFiltered
          ? 1
          : 0)

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    if (hasIsoZoom && timeWindow.sinceIso) {
      const startMs = Date.parse(timeWindow.sinceIso)
      const endMs = timeWindow.untilIso
        ? Date.parse(timeWindow.untilIso)
        : Date.now()
      const bounds = formatHistogramBoundPair(startMs, endMs)
      chips.push({
        id: "zoom",
        label: "Zoom",
        value: `${bounds.start} – ${bounds.end}`,
        onRemove: () => onQuickRange("live"),
      })
    } else if (hasCustomDates) {
      if (timeWindow.from) {
        chips.push({
          id: "from",
          label: "From",
          value: timeWindow.from,
          onRemove: () => setFromDate(undefined),
        })
      }
      if (timeWindow.to) {
        chips.push({
          id: "to",
          label: "Until",
          value: timeWindow.to,
          onRemove: () => setToDate(undefined),
        })
      }
    } else if (timeWindow.range !== "live") {
      chips.push({
        id: "range",
        label: "Range",
        value: timeWindow.range,
        onRemove: () => onQuickRange("live"),
      })
    }
    // Lane order matches TYPE sidebar — same Set, stable scan order.
    for (const et of EVENT_STREAM_LANES) {
      if (!typeFilters.has(et)) continue
      chips.push({
        id: `type:${et}`,
        label: "Type",
        value: et,
        onRemove: () => {
          setTypeFilters((prev) => {
            const next = new Set(prev)
            next.delete(et)
            return next
          })
        },
      })
    }
    if (errorsOnly) {
      chips.push({
        id: "errors",
        label: "Errors",
        value: "only",
        onRemove: () => setErrorsOnly(false),
      })
    }
    return chips
  }, [
    hasIsoZoom,
    hasCustomDates,
    timeWindow.from,
    timeWindow.to,
    timeWindow.sinceIso,
    timeWindow.untilIso,
    timeWindow.range,
    typeFilters,
    errorsOnly,
    setFromDate,
    setToDate,
    onQuickRange,
  ])

  function clearAllFilters(): void {
    setTypeFilters(new Set())
    setErrorsOnly(false)
    setHistogramFocus(null)
    clearCustomDates()
    onQuickRange("live")
  }

  return (
    <div ref={rootRef} className={WIDGET_LOG_SHELL_CLASS}>
      <div className={WIDGET_LOG_STACK_CLASS}>
      <div className={WIDGET_REVIEW_CONTROLS_CLASS}>
      <div className={WIDGET_REVIEW_CONTROLS_INSET_CLASS}>
      <WidgetToolbar compact={compact}>
        <WidgetToolbarLeading>{null}</WidgetToolbarLeading>
        <WidgetToolbarSearch
          inputRef={searchInputRef}
          value={searchText}
          onChange={setSearchText}
          placeholder="Filter events (type:api status:500)…"
          shortcutHint="/"
          loading={searching || loading}
          onClear={() => setSearchText("")}
        />
        <WidgetToolbarTrailing>
          <WidgetToolbarCount filtered={displayRows.length} total={entries.length} hidden={tiny} />
          <button
            ref={filterBtnRef}
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`widget-toolbar__icon-btn ${
              filtersOpen || filtersActive ? "widget-toolbar__icon-btn--active" : ""
            }`}
            title={
              filtersActive
                ? `Filters (${activeFilterCount} active)`
                : "Filters"
            }
            aria-pressed={filtersOpen || filtersActive}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
            {filtersActive && (
              <span className="widget-toolbar__icon-badge" aria-hidden>
                {activeFilterCount > 9 ? "9+" : activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            title={paused ? `Resume (${pendingLiveCount} buffered)` : "Pause live append"}
            className={`widget-toolbar__icon-btn ${
              paused ? "text-error" : ""
            }`}
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused && pendingLiveCount > 0 && (
              <span className="widget-toolbar__icon-badge" aria-hidden>
                {pendingLiveCount > 99 ? "99+" : pendingLiveCount}
              </span>
            )}
          </button>
        </WidgetToolbarTrailing>
      </WidgetToolbar>
      </div>

      {activeChips.length > 0 ? (
      <div className={WIDGET_REVIEW_CONTROLS_INSET_CLASS}>
      <ActiveFilterChips
        chips={activeChips}
        onClear={activeFilterCount > 0 ? clearAllFilters : undefined}
      />
      </div>
      ) : null}
      </div>

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        anchorRef={filterBtnRef}
        footer={
          filtersActive ? (
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-sm font-medium text-text-muted hover:text-text"
            >
              Clear all
            </button>
          ) : null
        }
      >
        <FilterField label="Quick range">
          <FilterChoiceGrid
            options={QUICK_RANGES.map((r) => ({ value: r.id, label: r.label }))}
            values={hasCustomDates ? [] : [timeWindow.range]}
            onChange={(values) => {
              const next = values[0]
              if (next) onQuickRange(next)
            }}
            columns={3}
            mode="single"
          />
        </FilterField>
        <div className="grid grid-cols-2 gap-3">
          <FilterField label="From">
            <DateField
              value={timeWindow.from}
              onChange={(from) => {
                setHistogramFocus(null)
                setFromDate(from || undefined)
              }}
              placeholder="Pick date"
              ariaLabel="From"
              size="sm"
              className="w-full"
            />
          </FilterField>
          <FilterField label="Until">
            <DateField
              value={timeWindow.to}
              onChange={(to) => {
                setHistogramFocus(null)
                setToDate(to || undefined)
              }}
              placeholder="Pick date"
              ariaLabel="Until"
              size="sm"
              className="w-full"
            />
          </FilterField>
        </div>
        <FilterField label="Type">
          <FilterChoiceGrid
            options={TYPE_OPTIONS}
            values={[...typeFilters]}
            onChange={(values) => setTypeFilters(new Set(values))}
            columns={3}
            mode="multi"
          />
        </FilterField>
        <FilterField label="Severity">
          <FilterChoiceGrid
            options={[{ value: "errors" as const, label: "Errors only" }]}
            values={errorsOnly ? ["errors"] : []}
            onChange={(values) => setErrorsOnly(values.includes("errors"))}
            columns={3}
            mode="multi"
          />
        </FilterField>
      </FilterSheet>

      <EventStreamHistogram
        lensRows={lensRows}
        bounds={windowBounds}
        focus={histogramFocus}
        onFocusChange={setHistogramFocus}
        onZoomToFocus={(next) => {
          setHistogramFocus(null)
          zoomToIsoRange(next.since, next.until)
        }}
        listVisibleCount={displayRows.length}
        typeFilters={typeFilters}
        errorsOnly={errorsOnly}
        searchText={searchText}
      />

      {(pendingLiveCount > 0 && (paused || !followLive)) && (
        <button
          type="button"
          className="event-stream-jump-live"
          onClick={resumeLiveFeed}
        >
          <Radio size={14} />
          {pendingLiveCount} new event{pendingLiveCount === 1 ? "" : "s"} — Jump to live
        </button>
      )}

      {error && (
        <div className="mia-callout mia-callout--err py-2 px-2.5 text-sm rounded">
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        className={`${WIDGET_LOG_SCROLL_CLASS} log-stream`}
        onScroll={onScroll}
      >
        <div ref={topSentinelRef} />

        {loadingOlder && (
          <div className="py-2 text-sm text-text-muted text-center">Loading older events…</div>
        )}
        {!loadingOlder && hasMore && (
          <button
            type="button"
            className="event-stream-load-older"
            onClick={() => loadOlder()}
          >
            Load older events
          </button>
        )}

        {loading && entries.length === 0 && (
          <EmptyState icon={WIDGET_ICONS["live-logs"]} message="Loading event history…" />
        )}

        {!loading && entries.length === 0 && !searchActive && (
          <EmptyState icon={WIDGET_ICONS["live-logs"]} message="No events in this time range." />
        )}

        {displayRows.length > 0 && (
          <VirtualList
            ref={listRef}
            items={displayRows}
            scrollRef={containerRef}
            estimateSize={() => 36}
            getItemKey={(i, log) => eventStreamRowKey(log, i)}
            renderItem={({ item: log, index }) => {
              const rowKey = eventStreamRowKey(log, index)
              return (
                <LogRow
                  log={log}
                  rowKey={rowKey}
                  selected={selectedKey === rowKey}
                  expanded={expandedKeys.has(rowKey)}
                  onSelect={() => setSelectedKey(rowKey)}
                  onToggleExpand={() => onKeyboardToggleFold(rowKey)}
                  setTypeFilters={setTypeFilters}
                  compact={compact}
                  tiny={tiny}
                />
              )
            }}
          />
        )}

        {filteredForWindow.length === 0 && searchOnly.length > 0 && (
          <div className="py-2 text-sm text-text-muted bg-elevated/30 border-t border-border-subtle">
            More matches in this range beyond the loaded page ({searchOnly.length})
          </div>
        )}

        {showEmpty && searchActive && (
          <EmptyState
            icon={Filter}
            message="No matches in this range."
            detail="Widen the time range, clear filters, or try different keywords."
          />
        )}

      </div>

      {!autoScroll && !paused && followLive && (
        <button
          type="button"
          className="event-stream-jump"
          onClick={scrollToLatest}
          title="Jump to latest (End)"
        >
          <ArrowDown size={14} /> Jump to latest
          <kbd className="composer-kbd event-stream-jump__kbd">End</kbd>
        </button>
      )}
      </div>
    </div>
  )
}

function LogRow({
  log,
  rowKey,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
  setTypeFilters,
  compact,
  tiny,
}: {
  log: LogEntry
  rowKey: string
  selected: boolean
  expanded: boolean
  onSelect: () => void
  onToggleExpand: () => void
  setTypeFilters: React.Dispatch<React.SetStateAction<Set<EventType>>>
  compact: boolean
  tiny: boolean
}) {
  const hasData = eventStreamHasPayload(log)
  const isError = Boolean(log.error)

  const lane = log.type as EventType

  const open = expanded && hasData

  return (
    <div
      className={[
        "event-stream-entry",
        selected ? "is-selected" : "",
        open ? "is-open" : "",
      ].join(" ")}
      data-event-row={rowKey}
    >
      <div
        className={[
          "event-stream-row",
          isError ? "event-stream-row--has-error" : "",
          open ? "event-stream-row--open" : "",
          hasData ? "cursor-pointer" : "",
        ].join(" ")}
        onClick={() => {
          onSelect()
          if (hasData) onToggleExpand()
        }}
      >
        {isError ? (
          <span className="event-stream-row__pill-slot">
            <span className={`${operationStatusPill("failed")} event-stream-row__pill`}>Error</span>
          </span>
        ) : null}
        <span className="review-chevron-slot shrink-0 text-text-muted/40">
          {hasData ? (
            <ChevronRight
              size={13}
              strokeWidth={1.75}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          ) : null}
        </span>
        <span className="event-stream-row__time" title={log.timestamp}>
          {formatEventStreamRowTime(log.timestamp, { tiny })}
        </span>
        <button
          type="button"
          className={["event-stream-row__type", eventStreamTypeClass(lane)].join(" ")}
          onClick={(e) => {
            e.stopPropagation()
            setTypeFilters((prev) => {
              const next = new Set(prev)
              if (next.has(lane)) next.delete(lane)
              else next.add(lane)
              return next
            })
          }}
        >
          {lane}
        </button>
        {!tiny && log.eventName ? (
          <span className="event-stream-row__event" title={log.eventName}>
            {log.eventName}
          </span>
        ) : (
          <span className="event-stream-row__event" aria-hidden />
        )}
        {log.message ? (
          <>
            <span className="event-stream-row__sep" aria-hidden>
              —
            </span>
            <span
              className={[
                "event-stream-row__message",
                isError ? "event-stream-row__message--err" : "text-text-muted",
              ].join(" ")}
              title={log.message}
            >
              {log.message}
            </span>
          </>
        ) : (
          <>
            <span className="event-stream-row__sep" aria-hidden />
            <span className="event-stream-row__message" aria-hidden />
          </>
        )}
      </div>
      {expanded && log.data && (
        <div className="event-stream-payload">
          <div
            className={
              isError
                ? "event-stream-payload__box event-stream-payload__box--err"
                : "event-stream-payload__box"
            }
          >
            {log.eventName && isSyncSqlEventType(log.eventName) && (
              <SqlTraceFromEventData data={log.data} compact maxHeight={compact ? 120 : 180} />
            )}
            <JsonViewer
              value={log.data}
              label="payload"
              defaultExpandDepth={2}
              maxHeight={compact ? 160 : 240}
            />
          </div>
        </div>
      )}
    </div>
  )
}
