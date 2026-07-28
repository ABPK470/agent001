/**
 * Operations capability owner — one REST head + one EventSource per window.
 * Widgets are lenses (kind/search); they retain/release but never own transport.
 */

import { create } from "zustand"
import type { OperationPipeline, OperationsResponse } from "../client/index"
import { api } from "../client/index"
import { attachViewingAsQuery } from "../lib/viewing-as"
import {
  mergeHeadRefresh,
  mergeOperationPipelines,
  OPERATIONS_PAGE_EVENT_LIMIT,
  type OperationLogKindView,
} from "../lib/operations-pipelines"

export type { OperationLogKindView }
export {
  mergeHeadRefresh,
  mergeOperationPipelines,
  OPERATIONS_PAGE_EVENT_LIMIT,
} from "../lib/operations-pipelines"

function serverKindParam(kindView: OperationLogKindView): string | undefined {
  return kindView === "all" ? undefined : kindView
}

function serverSearchParam(search: string): string | undefined {
  const trimmed = search.trim()
  return trimmed.length >= 2 ? trimmed : undefined
}

function operationsStreamUrl(kindView: OperationLogKindView, search: string): string {
  const params = new URLSearchParams()
  const kind = serverKindParam(kindView)
  const q = serverSearchParam(search)
  if (kind) params.set("kind", kind)
  if (q) params.set("search", q)
  const qs = params.toString()
  return attachViewingAsQuery(`/api/operations/stream${qs ? `?${qs}` : ""}`)
}

function isOperationsSnapshot(data: unknown): data is OperationsResponse {
  return (
    typeof data === "object" &&
    data != null &&
    Array.isArray((data as OperationsResponse).operations)
  )
}

interface OperationsState {
  pipelines: OperationPipeline[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  cursorBefore: string | null
  error: string | null
  kind: OperationLogKindView
  search: string
  viewingAsUpn: string | null
  /** When true, SSE snapshots update state but UI subscribers may freeze. */
  paintSuspended: boolean

  retain: (lens: {
    kind: OperationLogKindView
    search: string
    viewingAsUpn: string | null
  }) => void
  release: () => void
  setLens: (lens: {
    kind: OperationLogKindView
    search: string
    viewingAsUpn: string | null
  }) => void
  loadMore: () => void
  setPaintSuspended: (suspended: boolean) => void
}

interface Transport {
  refCount: number
  es: EventSource | null
  abort: AbortController | null
  listGeneration: number
  loadingMore: boolean
  visibilityHandler: (() => void) | null
}

const transport: Transport = {
  refCount: 0,
  es: null,
  abort: null,
  listGeneration: 0,
  loadingMore: false,
  visibilityHandler: null,
}

function stopTransport(): void {
  transport.es?.close()
  transport.es = null
  transport.abort?.abort()
  transport.abort = null
  if (transport.visibilityHandler) {
    document.removeEventListener("visibilitychange", transport.visibilityHandler)
    transport.visibilityHandler = null
  }
}

async function fetchPage(
  kind: OperationLogKindView,
  search: string,
  before: string | undefined,
  signal: AbortSignal,
): Promise<OperationsResponse> {
  return api.operations({
    limit: OPERATIONS_PAGE_EVENT_LIMIT,
    before,
    kind: serverKindParam(kind),
    search: serverSearchParam(search),
    signal,
  })
}

function openStream(get: () => OperationsState, set: (partial: Partial<OperationsState>) => void): void {
  const { kind, search } = get()
  transport.es?.close()
  const es = new EventSource(operationsStreamUrl(kind, search), { withCredentials: true })
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string) as unknown
      if (!isOperationsSnapshot(data)) return
      if (document.visibilityState === "hidden") return
      // Keep buffer warm under solo-hide; UI freezes via selector snapshot.
      const prev = get()
      set({
        pipelines: mergeHeadRefresh(prev.pipelines, data.operations, data.oldestTimestamp),
        cursorBefore: prev.cursorBefore ?? data.oldestTimestamp,
        hasMore: prev.hasMore || data.hasMore,
      })
    } catch (err: unknown) {
      console.error("[mia]", err)
    }
  }
  transport.es = es
}

function reloadHead(get: () => OperationsState, set: (partial: Partial<OperationsState>) => void): void {
  transport.abort?.abort()
  const ac = new AbortController()
  transport.abort = ac
  const gen = ++transport.listGeneration
  transport.loadingMore = false
  const { kind, search } = get()
  set({
    loading: true,
    loadingMore: false,
    error: null,
    cursorBefore: null,
    hasMore: false,
    pipelines: [],
  })

  void fetchPage(kind, search, undefined, ac.signal)
    .then((res) => {
      if (gen !== transport.listGeneration) return
      set({
        pipelines: res.operations,
        cursorBefore: res.oldestTimestamp,
        hasMore: res.hasMore,
        loading: false,
      })
    })
    .catch((err: unknown) => {
      if (gen !== transport.listGeneration) return
      if (err instanceof DOMException && err.name === "AbortError") return
      if (err instanceof Error && err.name === "AbortError") return
      set({
        pipelines: [],
        error: err instanceof Error ? err.message : "Failed to load operations",
        loading: false,
      })
    })
}

function ensureVisibilityRefresh(
  get: () => OperationsState,
  set: (partial: Partial<OperationsState>) => void,
): void {
  if (transport.visibilityHandler) return
  const onVisible = (): void => {
    if (document.visibilityState !== "visible") return
    if (transport.refCount <= 0) return
    const ac = new AbortController()
    const { kind, search } = get()
    void fetchPage(kind, search, undefined, ac.signal)
      .then((res) => {
        const prev = get()
        set({
          pipelines: mergeHeadRefresh(prev.pipelines, res.operations, res.oldestTimestamp),
          cursorBefore: prev.cursorBefore ?? res.oldestTimestamp,
          hasMore: prev.hasMore || res.hasMore,
        })
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        console.error("[mia]", err)
      })
  }
  transport.visibilityHandler = onVisible
  document.addEventListener("visibilitychange", onVisible)
}

export const useOperationsStore = create<OperationsState>((set, get) => ({
  pipelines: [],
  loading: true,
  loadingMore: false,
  hasMore: false,
  cursorBefore: null,
  error: null,
  kind: "all",
  search: "",
  viewingAsUpn: null,
  paintSuspended: false,

  retain(lens) {
    const first = transport.refCount === 0
    transport.refCount++
    const lensChanged =
      get().kind !== lens.kind ||
      get().search !== lens.search ||
      get().viewingAsUpn !== lens.viewingAsUpn
    set({
      kind: lens.kind,
      search: lens.search,
      viewingAsUpn: lens.viewingAsUpn,
    })
    if (first) {
      ensureVisibilityRefresh(get, set)
      reloadHead(get, set)
      openStream(get, set)
    } else if (lensChanged) {
      reloadHead(get, set)
      openStream(get, set)
    }
  },

  release() {
    transport.refCount = Math.max(0, transport.refCount - 1)
    if (transport.refCount === 0) {
      stopTransport()
      set({
        pipelines: [],
        loading: false,
        loadingMore: false,
        hasMore: false,
        cursorBefore: null,
        error: null,
      })
    }
  },

  setLens(lens) {
    if (
      get().kind === lens.kind &&
      get().search === lens.search &&
      get().viewingAsUpn === lens.viewingAsUpn
    ) {
      return
    }
    set({
      kind: lens.kind,
      search: lens.search,
      viewingAsUpn: lens.viewingAsUpn,
    })
    if (transport.refCount > 0) {
      reloadHead(get, set)
      openStream(get, set)
    }
  },

  loadMore() {
    const s = get()
    if (transport.loadingMore || s.loadingMore || !s.hasMore || !s.cursorBefore) return
    if (s.loading) return
    const gen = transport.listGeneration
    const ac = new AbortController()
    transport.loadingMore = true
    set({ loadingMore: true })
    void fetchPage(s.kind, s.search, s.cursorBefore, ac.signal)
      .then((res) => {
        if (gen !== transport.listGeneration) return
        const prev = get()
        const merged = mergeOperationPipelines(prev.pipelines, res.operations)
        const grew = merged.length > prev.pipelines.length
        set({
          pipelines: merged,
          cursorBefore: res.oldestTimestamp,
          hasMore: grew || res.operations.length > 0 ? res.hasMore : false,
        })
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        console.error("[mia]", err)
      })
      .finally(() => {
        if (gen === transport.listGeneration) {
          transport.loadingMore = false
          set({ loadingMore: false })
        }
      })
  },

  setPaintSuspended(suspended) {
    set({ paintSuspended: suspended })
  },
}))

/** Test-only: reset module transport between cases. */
export function _resetOperationsTransportForTests(): void {
  stopTransport()
  transport.refCount = 0
  transport.listGeneration = 0
  transport.loadingMore = false
}
