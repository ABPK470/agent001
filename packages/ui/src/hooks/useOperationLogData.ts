/**
 * Operation Log lens — retains the shared operations capability owner.
 * No EventSource / REST ownership here.
 */

import { useEffect, useRef, useState } from "react"
import { useTilePaint } from "../app/workspace/tile-paint"
import { useViewingAs } from "./useViewingAs"
import {
  useOperationsStore,
  type OperationLogKindView,
} from "../state/operations-store"

export {
  mergeHeadRefresh,
  mergeOperationPipelines,
  OPERATIONS_PAGE_EVENT_LIMIT,
  type OperationLogKindView,
} from "../lib/operations-pipelines"

export interface UseOperationLogDataResult {
  pipelines: ReturnType<typeof useOperationsStore.getState>["pipelines"]
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
  const { soloHidden } = useTilePaint()
  const [searchQuery, setSearchQuery] = useState(search)

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const retain = useOperationsStore((s) => s.retain)
  const release = useOperationsStore((s) => s.release)
  const setLens = useOperationsStore((s) => s.setLens)
  const loadMore = useOperationsStore((s) => s.loadMore)
  const setPaintSuspended = useOperationsStore((s) => s.setPaintSuspended)

  const pipelines = useOperationsStore((s) => s.pipelines)
  const loading = useOperationsStore((s) => s.loading)
  const loadingMore = useOperationsStore((s) => s.loadingMore)
  const hasMore = useOperationsStore((s) => s.hasMore)
  const error = useOperationsStore((s) => s.error)
  const paintSuspended = useOperationsStore((s) => s.paintSuspended)

  const frozenRef = useRef(pipelines)
  if (!paintSuspended) frozenRef.current = pipelines

  useEffect(() => {
    setPaintSuspended(soloHidden)
  }, [soloHidden, setPaintSuspended])

  useEffect(() => {
    retain({
      kind: kindView,
      search: searchQuery,
      viewingAsUpn,
    })
    return () => release()
  }, [retain, release])

  useEffect(() => {
    setLens({
      kind: kindView,
      search: searchQuery,
      viewingAsUpn,
    })
  }, [kindView, searchQuery, viewingAsUpn, setLens])

  return {
    pipelines: paintSuspended || soloHidden ? frozenRef.current : pipelines,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
  }
}
