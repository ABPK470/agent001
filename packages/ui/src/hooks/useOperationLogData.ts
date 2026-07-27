/**
 * Operation Log data layer — one source: SQLite event_log via GET /api/operations.
 *
 * - REST: initial load, filter changes, infinite scroll (before cursor).
 * - SSE: debounced head snapshots pushed by the server (no client refetch loop).
 *
 * Viewing as must not storm the server: one scope change → one in-flight list
 * (abort prior), and infinite scroll never auto-chains while loading.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { OperationPipeline, OperationsResponse } from "../client/index"
import { api } from "../client/index"
import { attachViewingAsQuery } from "../lib/viewing-as"
import { useViewingAs } from "./useViewingAs"

/** Must match server OPERATIONS_PAGE_EVENT_LIMIT. */
export const OPERATIONS_PAGE_EVENT_LIMIT = 2000

export type OperationLogKindView = "all" | "agent" | "sync" | "bridge"

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
  return attachViewingAsQuery(`/api/operations/stream${qs ? `?${qs}` : ""}`)
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
  error: string | null
}

export function useOperationLogData(opts: {
  kindView: OperationLogKindView
  search: string
}): UseOperationLogDataResult {
  const { kindView, search } = opts
  const { viewingAsUpn } = useViewingAs()

  const [pipelines, setPipelines] = useState<OperationPipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [cursorBefore, setCursorBefore] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listGeneration = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const loadingMoreRef = useRef(false)
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
    async (before: string | undefined, signal: AbortSignal) => {
      return api.operations({
        limit: OPERATIONS_PAGE_EVENT_LIMIT,
        before,
        kind: serverKindParam(kindView),
        search: serverSearchParam(debouncedSearch.current),
        signal,
      })
    },
    [kindView],
  )

  useEffect(() => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const gen = ++listGeneration.current
    loadingMoreRef.current = false
    setLoading(true)
    setLoadingMore(false)
    setError(null)
    setCursorBefore(null)
    setHasMore(false)
    setPipelines([])

    void fetchListPage(undefined, ac.signal)
      .then((res) => {
        if (gen !== listGeneration.current) return
        setPipelines(res.operations)
        setCursorBefore(res.oldestTimestamp)
        setHasMore(res.hasMore)
      })
      .catch((err: unknown) => {
        if (gen !== listGeneration.current) return
        if (err instanceof DOMException && err.name === "AbortError") return
        if (err instanceof Error && err.name === "AbortError") return
        setPipelines([])
        setError(err instanceof Error ? err.message : "Failed to load operations")
      })
      .finally(() => {
        if (gen === listGeneration.current) setLoading(false)
      })
      .catch((err: unknown) => { console.error("[mia]", err) })

    return () => {
      ac.abort()
    }
  }, [kindView, searchQuery, fetchListPage, viewingAsUpn])

  useEffect(() => {
    const es = new EventSource(
      operationsStreamUrl(kindView, debouncedSearch.current),
      { withCredentials: true },
    )
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as unknown
        if (!isOperationsSnapshot(data)) return
        if (document.visibilityState === "hidden") return
        setPipelines((prev) =>
          mergeHeadRefresh(prev, data.operations, data.oldestTimestamp),
        )
        setCursorBefore((before) => before ?? data.oldestTimestamp)
        setHasMore((more) => more || data.hasMore)
      } catch (err: unknown) { console.error("[mia]", err) }
    }
    return () => es.close()
  }, [kindView, searchQuery, viewingAsUpn])

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return
      const ac = new AbortController()
      void fetchListPage(undefined, ac.signal)
        .then((res) => {
          setPipelines((prev) =>
            mergeHeadRefresh(prev, res.operations, res.oldestTimestamp),
          )
          setCursorBefore((before) => before ?? res.oldestTimestamp)
          setHasMore((more) => more || res.hasMore)
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          console.error("[mia]", err)
        })
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [fetchListPage])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || loadingMore || !hasMore || !cursorBefore) return
    if (loading) return
    const gen = listGeneration.current
    const ac = new AbortController()
    loadingMoreRef.current = true
    setLoadingMore(true)
    void fetchListPage(cursorBefore, ac.signal)
      .then((res) => {
        if (gen !== listGeneration.current) return
        let grew = false
        setPipelines((prev) => {
          const merged = mergeOperationPipelines(prev, res.operations)
          grew = merged.length > prev.length
          return merged
        })
        setCursorBefore(res.oldestTimestamp)
        // Empty productive page: stop infinite-scroll chaining (server fill
        // should make this rare; this is the client backstop).
        setHasMore(grew || res.operations.length > 0 ? res.hasMore : false)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        console.error("[mia]", err)
      })
      .finally(() => {
        if (gen === listGeneration.current) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      })
      .catch((err: unknown) => { console.error("[mia]", err) })
  }, [loading, loadingMore, hasMore, cursorBefore, fetchListPage])

  return {
    pipelines,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
  }
}
