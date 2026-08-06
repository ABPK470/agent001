/**
 * Event Stream capability — windowed history + live tip from global store.logs.
 * One loader per lens; widgets retain/release and set window/pause only.
 */

import { create } from "zustand"
import { api } from "../client/index"
import type { EventStreamWindow } from "../lib/event-stream-prefs"
import {
  EVENT_STREAM_EXCLUDE_TYPES,
  EVENT_STREAM_PAGE_SIZE,
  mergeLogEntries,
  resolveWindowBounds,
} from "../lib/event-stream-window"
import { formatLogEntry, useStore } from "./store"
import type { LogEntry } from "../types"

function mapRawEvents(
  events: Array<{ type: string; data: Record<string, unknown>; timestamp: string }>,
): LogEntry[] {
  const out: LogEntry[] = []
  for (const ev of events) {
    const entry = formatLogEntry(ev.type, ev.data ?? {}, ev.timestamp)
    if (entry) out.push(entry)
  }
  return out
}

function windowFingerprint(window: EventStreamWindow, viewingAs: string | null): string {
  return JSON.stringify({
    range: window.range,
    from: window.from ?? null,
    to: window.to ?? null,
    sinceIso: window.sinceIso ?? null,
    untilIso: window.untilIso ?? null,
    viewingAs,
  })
}

interface EventStreamState {
  entries: LogEntry[]
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  oldestCursor: string | null
  error: string | null
  pendingLiveCount: number
  window: EventStreamWindow
  viewingAsUpn: string | null
  paused: boolean
  paintSuspended: boolean
  followLive: boolean

  retain: (lens: {
    window: EventStreamWindow
    viewingAsUpn: string | null
    paused: boolean
  }) => void
  release: () => void
  setWindow: (window: EventStreamWindow) => void
  setPaused: (paused: boolean) => void
  setViewingAs: (viewingAsUpn: string | null) => void
  loadOlder: () => void
  jumpToLive: () => void
  setPaintSuspended: (suspended: boolean) => void
}

interface Transport {
  refCount: number
  generation: number
  liveWatermark: string
  pendingAck: string
  unsubLogs: (() => void) | null
  fingerprint: string
}

const transport: Transport = {
  refCount: 0,
  generation: 0,
  liveWatermark: "",
  pendingAck: "",
  unsubLogs: null,
  fingerprint: "",
}

function applyLiveTip(
  get: () => EventStreamState,
  set: (p: Partial<EventStreamState>) => void,
): void {
  const logs = useStore.getState().logs
  if (logs.length === 0) return
  const s = get()
  const bounds = resolveWindowBounds(s.window)
  const fresh = logs.filter((l) => {
    if (l.eventName === "debug.trace") return false
    if (!l.timestamp) return false
    if (transport.liveWatermark && l.timestamp <= transport.liveWatermark) return false
    if (l.timestamp < bounds.since) return false
    if (bounds.until && l.timestamp > bounds.until) return false
    return true
  })
  if (fresh.length === 0) return

  const followLive = bounds.followLive && !s.paused
  if (!followLive) {
    const unacked = fresh.filter(
      (l) => !transport.pendingAck || l.timestamp > transport.pendingAck,
    )
    if (unacked.length === 0) return
    transport.pendingAck = unacked[unacked.length - 1]!.timestamp
    set({ pendingLiveCount: s.pendingLiveCount + unacked.length })
    return
  }

  const merged = mergeLogEntries(s.entries, fresh)
  const newest = merged[merged.length - 1]?.timestamp
  if (newest) {
    transport.liveWatermark = newest
    transport.pendingAck = newest
  }
  set({ entries: merged, pendingLiveCount: 0 })
}

function ensureLiveSubscription(
  get: () => EventStreamState,
  set: (p: Partial<EventStreamState>) => void,
): void {
  if (transport.unsubLogs) return
  transport.unsubLogs = useStore.subscribe(() => {
    if (transport.refCount <= 0) return
    applyLiveTip(get, set)
  })
}

function reload(
  get: () => EventStreamState,
  set: (p: Partial<EventStreamState>) => void,
): void {
  const gen = ++transport.generation
  const s = get()
  const bounds = resolveWindowBounds(s.window)
  transport.fingerprint = windowFingerprint(s.window, s.viewingAsUpn)
  transport.liveWatermark = ""
  transport.pendingAck = ""
  set({
    loading: true,
    error: null,
    pendingLiveCount: 0,
    hasMore: false,
    oldestCursor: null,
    followLive: bounds.followLive,
    entries: [],
  })

  void api
    .listEvents({
      limit: EVENT_STREAM_PAGE_SIZE,
      since: bounds.since,
      until: bounds.until,
      exclude_types: [...EVENT_STREAM_EXCLUDE_TYPES],
    })
    .then((res) => {
      if (gen !== transport.generation) return
      const mapped = mapRawEvents(res.events)
      if (res.newestTimestamp) transport.liveWatermark = res.newestTimestamp
      set({
        entries: mergeLogEntries(mapped),
        oldestCursor: res.oldestTimestamp,
        hasMore: res.hasMore,
        loading: false,
      })
    })
    .catch((err: unknown) => {
      if (gen !== transport.generation) return
      set({
        entries: [],
        error: err instanceof Error ? err.message : "Failed to load events",
        loading: false,
      })
    })
}

export const useEventStreamStore = create<EventStreamState>((set, get) => ({
  entries: [],
  loading: true,
  loadingOlder: false,
  hasMore: false,
  oldestCursor: null,
  error: null,
  pendingLiveCount: 0,
  window: { range: "live" },
  viewingAsUpn: null,
  paused: false,
  paintSuspended: false,
  followLive: true,

  retain(lens) {
    const first = transport.refCount === 0
    transport.refCount++
    const fp = windowFingerprint(lens.window, lens.viewingAsUpn)
    const changed = fp !== transport.fingerprint
    set({
      window: lens.window,
      viewingAsUpn: lens.viewingAsUpn,
      paused: lens.paused,
      followLive: resolveWindowBounds(lens.window).followLive,
    })
    if (first) {
      ensureLiveSubscription(get, set)
      reload(get, set)
    } else if (changed) {
      reload(get, set)
    } else {
      set({ paused: lens.paused })
    }
  },

  release() {
    transport.refCount = Math.max(0, transport.refCount - 1)
    if (transport.refCount === 0) {
      transport.unsubLogs?.()
      transport.unsubLogs = null
      transport.fingerprint = ""
      set({
        entries: [],
        loading: false,
        loadingOlder: false,
        hasMore: false,
        oldestCursor: null,
        error: null,
        pendingLiveCount: 0,
      })
    }
  },

  setWindow(window) {
    const fp = windowFingerprint(window, get().viewingAsUpn)
    set({ window, followLive: resolveWindowBounds(window).followLive })
    if (transport.refCount > 0 && fp !== transport.fingerprint) reload(get, set)
  },

  setPaused(paused) {
    set({ paused })
  },

  setViewingAs(viewingAsUpn) {
    if (get().viewingAsUpn === viewingAsUpn) return
    set({ viewingAsUpn })
    if (transport.refCount > 0) reload(get, set)
  },

  loadOlder() {
    const s = get()
    if (s.loadingOlder || !s.hasMore || !s.oldestCursor) return
    const gen = transport.generation
    const bounds = resolveWindowBounds(s.window)
    set({ loadingOlder: true })
    void api
      .listEvents({
        limit: EVENT_STREAM_PAGE_SIZE,
        since: bounds.since,
        until: bounds.until,
        before: s.oldestCursor,
        exclude_types: [...EVENT_STREAM_EXCLUDE_TYPES],
      })
      .then((res) => {
        if (gen !== transport.generation) return
        set({
          entries: mergeLogEntries(mapRawEvents(res.events), get().entries),
          oldestCursor: res.oldestTimestamp,
          hasMore: res.hasMore,
        })
      })
      .catch((err: unknown) => {
        console.error("[mia]", err)
      })
      .finally(() => {
        if (gen === transport.generation) set({ loadingOlder: false })
      })
  },

  jumpToLive() {
    set({ pendingLiveCount: 0, window: { range: "live" } })
    if (transport.refCount > 0) reload(get, set)
  },

  setPaintSuspended(suspended) {
    set({ paintSuspended: suspended })
  },
}))
