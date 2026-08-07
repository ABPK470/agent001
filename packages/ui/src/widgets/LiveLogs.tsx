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
import { useWidgetFocus } from "../hooks/useWidgetFocus"
import type { OperatorSurfaceHandler } from "../lib/operator-surface"
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
import { resolveEventStreamDetailMode } from "../lib/event-stream-detail-mode"
import { WIDGET_ICONS } from "./widget-icons"
import {
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WIDGET_REVIEW_CONTROLS_CLASS,
  WIDGET_REVIEW_CONTROLS_INSET_CLASS,
  WidgetToolbar,
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
import { EventStreamDetailDrawer } from "./live-logs/EventStreamDetailDrawer"
import { LiveLogsZenHud } from "./live-logs/LiveLogsZenHud"

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
  const { isZen, isSolo, toggleZen, exitZen } = useWidgetFocus()
  const surfaceArmed = useOperatorSurfaceArmed({ layoutFocus: isZen || isSolo })
  const initialPrefs = useMemo(() => readEventStreamPrefs(tileId), [tileId])

  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [typeFilters, setTypeFilters] = useState<Set<EventType>>(
    () => new Set(initialPrefs.typeFilters),
  )
  const [errorsOnly, setErrorsOnly] = useState(() => initialPrefs.errorsOnly)
  const [searchText, setSearchText] = useState(() => initialPrefs.searchText)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [zenSearchOpen, setZenSearchOpen] = useState(false)
  const [histogramFocus, setHistogramFocus] = useState<EventStreamHistogramFocus | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** One open detail — presentation is drawer vs inline by tile width. */
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const detailKeyRef = useRef<string | null>(null)
  detailKeyRef.current = detailKey
  const filtersOpenRef = useRef(false)
  filtersOpenRef.current = filtersOpen
  const zenSearchOpenRef = useRef(false)
  zenSearchOpenRef.current = zenSearchOpen
  const searchTextRef = useRef(searchText)
  searchTextRef.current = searchText
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
  const detailMode = resolveEventStreamDetailMode(rootWidth)

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

  const detailLog = useMemo(() => {
    if (!detailKey) return null
    for (let i = 0; i < displayRows.length; i++) {
      const log = displayRows[i]
      if (log && eventStreamRowKey(log, i) === detailKey) return log
    }
    return null
  }, [detailKey, displayRows])

  // Detail key is stable across resize (drawer ↔ inline); drop when the row leaves the lens.
  useEffect(() => {
    if (!detailKey) return
    if (!detailLog) setDetailKey(null)
  }, [detailKey, detailLog])

  function onDetailEscapeKeyDown(event: KeyboardEvent) {
    if (!detailKeyRef.current) return
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    setDetailKey(null)
  }

  useEffect(() => {
    if (!detailKey) return
    window.addEventListener("keydown", onDetailEscapeKeyDown, true)
    return () => window.removeEventListener("keydown", onDetailEscapeKeyDown, true)
  }, [detailKey])

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
    (node: ReviewTreeKeyboardNode) => detailKey !== node.scopeId,
    [detailKey],
  )

  const onKeyboardToggleFold = useCallback((scopeId: string) => {
    setDetailKey((prev) => (prev === scopeId ? null : scopeId))
  }, [])

  useEffect(() => {
    if (!isZen) setZenSearchOpen(false)
  }, [isZen])

  const zenBeforeRef = useRef<OperatorSurfaceHandler | null>(null)
  zenBeforeRef.current = (event) => {
    const key = event.key.toLowerCase()
    const mod = event.metaKey || event.ctrlKey
    if (key === "z" && !mod && !event.altKey && !event.shiftKey) {
      if (isZen) exitZen()
      else toggleZen()
      return true
    }
    if (isZen && ((mod && key === "f") || (key === "/" && !mod))) {
      setZenSearchOpen(true)
      return true
    }
    if (event.key === "Escape" && isZen) {
      if (detailKeyRef.current) {
        setDetailKey(null)
        return true
      }
      if (filtersOpenRef.current) {
        setFiltersOpen(false)
        return true
      }
      if (zenSearchOpenRef.current) {
        if (searchTextRef.current) setSearchText("")
        else setZenSearchOpen(false)
        return true
      }
      exitZen()
      return true
    }
    return false
  }

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
    onOpenSearch: () => {
      if (isZen) setZenSearchOpen(true)
      else searchInputRef.current?.focus()
    },
    onEnd: scrollToLatest,
    beforeRef: zenBeforeRef,
  })

  const hasIsoZoom = Boolean(timeWindow.sinceIso)
  const hasCustomDates = Boolean(timeWindow.from || timeWindow.to)
  const hasHistogramSelection = Boolean(histogramFocus)
  const timeFiltered =
    hasIsoZoom || hasCustomDates || timeWindow.range !== "live"
  const filtersActive =
    typeFilters.size > 0 || errorsOnly || timeFiltered || hasHistogramSelection
  const activeFilterCount =
    typeFilters.size
    + (errorsOnly ? 1 : 0)
    + (hasHistogramSelection ? 1 : 0)
    + (hasIsoZoom
      ? 1
      : hasCustomDates
        ? (timeWindow.from ? 1 : 0) + (timeWindow.to ? 1 : 0)
        : timeFiltered
          ? 1
          : 0)

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    // Brush selection already filters the list — chip appears the moment it does.
    if (histogramFocus) {
      const startMs = Date.parse(histogramFocus.since)
      const endMs = Date.parse(histogramFocus.until)
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        const bounds = formatHistogramBoundPair(startMs, endMs)
        chips.push({
          id: "selection",
          label: "Range",
          value: `${bounds.start} – ${bounds.end}`,
          onRemove: () => setHistogramFocus(null),
        })
      }
    }
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
    histogramFocus,
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

  const drawerDetailOpen = detailMode === "drawer" && Boolean(detailLog)

  return (
    <div
      ref={rootRef}
      className={[
        WIDGET_LOG_SHELL_CLASS,
        "event-stream-shell",
        isZen ? "event-stream-shell--zen" : "",
        drawerDetailOpen ? "event-stream-shell--detail-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="event-stream-main">
      <div className={`${WIDGET_LOG_STACK_CLASS} event-stream-stack`}>
      {isZen ? (
        <LiveLogsZenHud
          searchText={searchText}
          onSearchChange={setSearchText}
          searchOpen={zenSearchOpen}
          onSearchOpenChange={setZenSearchOpen}
          searching={searching || loading}
          filtersActive={filtersActive}
          activeFilterCount={activeFilterCount}
          onOpenFilters={() => setFiltersOpen((o) => !o)}
          filterBtnRef={filterBtnRef}
          paused={paused}
          onTogglePause={() => setPaused((p) => !p)}
          pendingLiveCount={pendingLiveCount}
          onExitZen={exitZen}
        />
      ) : null}
      <div className="event-stream-deck">
      {!isZen ? (
      <>
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
      </>
      ) : activeChips.length > 0 ? (
      <div className={WIDGET_REVIEW_CONTROLS_CLASS}>
      <div className={WIDGET_REVIEW_CONTROLS_INSET_CLASS}>
      <ActiveFilterChips
        chips={activeChips}
        onClear={activeFilterCount > 0 ? clearAllFilters : undefined}
      />
      </div>
      </div>
      ) : null}

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
            emptyMeansAll
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

      {/*
       * Feed is a hard clip shell; the scroll host inside is display:block
       * (not widget-panel-body flex) so abspos virtual rows cannot paint into
       * the histogram deck.
       */}
      <div className="event-stream-feed">
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
        className="event-stream-feed__scroll log-stream"
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
            estimateSize={(i) => {
              const log = displayRows[i]
              if (!log) return 36
              // Drawer mode keeps every row short — payload lives in the side panel.
              if (detailMode !== "inline") return 36
              const key = eventStreamRowKey(log, i)
              if (detailKey === key && eventStreamHasPayload(log)) {
                return compact ? 220 : 300
              }
              return 36
            }}
            /* Expanding must grow downward — never shove the header under the deck. */
            adjustScrollOnResize={false}
            getItemKey={(i, log) => eventStreamRowKey(log, i)}
            renderItem={({ item: log, index }) => {
              const rowKey = eventStreamRowKey(log, index)
              const detailOpen = detailKey === rowKey
              return (
                <LogRow
                  log={log}
                  rowKey={rowKey}
                  selected={selectedKey === rowKey}
                  detailOpen={detailOpen}
                  showInlinePayload={detailMode === "inline" && detailOpen}
                  onSelect={() => setSelectedKey(rowKey)}
                  onToggleDetail={() => onKeyboardToggleFold(rowKey)}
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
      </div>
      {detailMode === "drawer" ? (
        <EventStreamDetailDrawer
          open={Boolean(detailLog)}
          log={detailLog}
          onClose={() => setDetailKey(null)}
          compact={compact}
        />
      ) : null}
    </div>
  )
}

function LogRow({
  log,
  rowKey,
  selected,
  detailOpen,
  showInlinePayload,
  onSelect,
  onToggleDetail,
  setTypeFilters,
  compact,
  tiny,
}: {
  log: LogEntry
  rowKey: string
  selected: boolean
  detailOpen: boolean
  showInlinePayload: boolean
  onSelect: () => void
  onToggleDetail: () => void
  setTypeFilters: React.Dispatch<React.SetStateAction<Set<EventType>>>
  compact: boolean
  tiny: boolean
}) {
  const hasData = eventStreamHasPayload(log)
  const isError = Boolean(log.error)

  const lane = log.type as EventType

  const open = detailOpen && hasData

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
          if (hasData) onToggleDetail()
        }}
      >
        {isError ? (
          <span className="event-stream-row__pill-slot">
            <span className={`${operationStatusPill("failed")} event-stream-row__pill`}>Error</span>
          </span>
        ) : null}
        <span className="review-chevron-slot event-stream-row__chev-slot shrink-0 text-text-muted/40">
          {hasData ? (
            <ChevronRight
              size={13}
              strokeWidth={1.75}
              className={[
                "event-stream-row__chevron",
                /* Down only when payload expands under the row — never in drawer mode. */
                showInlinePayload ? "is-expanded" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-hidden
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
      {showInlinePayload && log.data ? (
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
      ) : null}
    </div>
  )
}
