/**
 * Operation Log data layer — one source: SQLite event_log via GET /api/operations.
 *
 * - REST: initial load, filter changes, infinite scroll (before cursor).
 * - SSE: debounced head snapshots pushed by the server (no client refetch loop).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { OperationPipeline, OperationsResponse } from "../api"
import { api } from "../api"
import type { OperationLogFocus } from "../store"

/** Must match server OPERATIONS_PAGE_EVENT_LIMIT. */
export const OPERATIONS_PAGE_EVENT_LIMIT = 2000

export type OperationLogKindView = "all" | "agent" | "sync"

export function mergeOperationPipelines(
  ...groups: OperationPipeline[][]
): OperationPipeline[] {
  const byId = new Map<string, OperationPipeline>()
  for (const group of groups) {
    for (const pipeline of group) {
      const existing = byId.get(pipeline.id)
      if (!existing || pipeline.eventCount > existing.eventCount) {
        byId.set(pipeline.id, pipeline)
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Merge a fresh head page with older pages already loaded via scroll. */
export function mergeHeadRefresh(
  current: OperationPipeline[],
  head: OperationPipeline[],
  oldestHeadTimestamp: string | null,
): OperationPipeline[] {
  if (!oldestHeadTimestamp) return head
  const headIds = new Set(head.map((p) => p.id))
  const tail = current.filter(
    (p) => !headIds.has(p.id) && p.startedAt < oldestHeadTimestamp,
  )
  return mergeOperationPipelines(head, tail)
}

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
  return `/api/operations/stream${qs ? `?${qs}` : ""}`
}

function isOperationsSnapshot(data: unknown): data is OperationsResponse {
  return (
    typeof data === "object" &&
    data != null &&
    Array.isArray((data as OperationsResponse).operations)
  )
}

export interface UseOperationLogDataResult {
  pipelines: OperationPipeline[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  loadMore: () => void
  mode: "list" | "focus"
  scannedEvents: number
  error: string | null
}

export function useOperationLogData(opts: {
  focus: OperationLogFocus | null
  kindView: OperationLogKindView
  search: string
}): UseOperationLogDataResult {
  const { focus, kindView, search } = opts

  const [pipelines, setPipelines] = useState<OperationPipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [cursorBefore, setCursorBefore] = useState<string | null>(null)
  const [mode, setMode] = useState<"list" | "focus">("list")
  const [scannedEvents, setScannedEvents] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const listGeneration = useRef(0)
  const debouncedSearch = useRef(search)
  const [searchQuery, setSearchQuery] = useState(search)

  useEffect(() => {
    const timer = setTimeout(() => {
      debouncedSearch.current = search
      setSearchQuery(search)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchListPage = useCallback(
    async (before?: string) => {
      return api.operations({
        limit: OPERATIONS_PAGE_EVENT_LIMIT,
        before,
        kind: serverKindParam(kindView),
        search: serverSearchParam(debouncedSearch.current),
      })
    },
    [kindView],
  )

  // Focus: full audit for one plan or run (REST only)
  useEffect(() => {
    if (!focus) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setMode("focus")
    setHasMore(false)
    setCursorBefore(null)

    const params =
      focus.kind === "plan"
        ? { planId: focus.id }
        : { runId: focus.id }

    void api
      .operations(params)
      .then((res) => {
        if (cancelled) return
        setPipelines(res.operations)
        setScannedEvents(res.scannedEvents)
        setMode(res.mode)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPipelines([])
        setScannedEvents(0)
        setError(err instanceof Error ? err.message : "Failed to load audit")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [focus])

  // List: REST load on filter change (once per change, not on every event)
  useEffect(() => {
    if (focus) return
    const gen = ++listGeneration.current
    setLoading(true)
    setError(null)
    setMode("list")
    setCursorBefore(null)
    setHasMore(false)

    void fetchListPage()
      .then((res) => {
        if (gen !== listGeneration.current) return
        setPipelines(res.operations)
        setScannedEvents(res.scannedEvents)
        setCursorBefore(res.oldestTimestamp)
        setHasMore(res.hasMore)
        setMode(res.mode)
      })
      .catch((err: unknown) => {
        if (gen !== listGeneration.current) return
        setPipelines([])
        setError(err instanceof Error ? err.message : "Failed to load operations")
      })
      .finally(() => {
        if (gen === listGeneration.current) setLoading(false)
      })
  }, [focus, kindView, searchQuery, fetchListPage])

  // SSE: server pushes debounced head snapshots — merge in place, no HTTP refetch
  useEffect(() => {
    if (focus) return
    const es = new EventSource(operationsStreamUrl(kindView, debouncedSearch.current), {
      withCredentials: true,
    })
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as unknown
        if (!isOperationsSnapshot(data)) return
        if (document.visibilityState === "hidden") return
        setPipelines((prev) =>
          mergeHeadRefresh(prev, data.operations, data.oldestTimestamp),
        )
        setScannedEvents(data.scannedEvents)
        setCursorBefore((before) => before ?? data.oldestTimestamp)
        setHasMore((more) => more || data.hasMore)
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [focus, kindView, searchQuery])

  // Refresh once when tab becomes visible again (SSE may have been skipped while hidden)
  useEffect(() => {
    if (focus) return
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return
      void fetchListPage()
        .then((res) => {
          setPipelines((prev) =>
            mergeHeadRefresh(prev, res.operations, res.oldestTimestamp),
          )
          setScannedEvents(res.scannedEvents)
          setCursorBefore((before) => before ?? res.oldestTimestamp)
          setHasMore((more) => more || res.hasMore)
        })
        .catch(() => { /* keep existing data */ })
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [focus, fetchListPage])

  const loadMore = useCallback(() => {
    if (focus || loadingMore || !hasMore || !cursorBefore) return
    setLoadingMore(true)
    void fetchListPage(cursorBefore)
      .then((res) => {
        setPipelines((prev) => mergeOperationPipelines(prev, res.operations))
        setCursorBefore(res.oldestTimestamp)
        setHasMore(res.hasMore)
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoadingMore(false))
  }, [focus, loadingMore, hasMore, cursorBefore, fetchListPage])

  return {
    pipelines,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    mode,
    scannedEvents,
    error,
  }
}
