/**
 * Activity — Linear-style operations view.
 * Same data as Pipelines; purpose-built UI inspired by linear.app issue lists.
 */

import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OperationPipeline } from "../../api"
import { api, OperationKind, OperationStatus } from "../../api"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useOperationLogData, type OperationLogKindView } from "../../hooks/useOperationLogData"
import { matchesPipeline, pipelineActivityKey, syncPlanIdFromPipeline } from "../../lib/operation-presentation"
import { OperationLogModalsProvider } from "../../operation-log-modals"
import { ActivityList } from "./ActivityList"
import { ActivityLogToolbar } from "./ActivityLogToolbar"

export { pipelineActivityKey, syncPlanIdFromPipeline }

export function ActivityLog() {
  const [kindView, setKindView] = useState<OperationLogKindView>("all")
  const [statuses, setStatuses] = useState<Set<OperationStatus>>(new Set())
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [actExpanded, setActExpanded] = useState<Set<string>>(new Set())
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(rootRef)
  const compact = width > 0 && width < 900

  const { pipelines, loading, loadingMore, hasMore, loadMore, error } = useOperationLogData({
    kindView,
    search,
  })

  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const cancelPipeline = useCallback(async (pipeline: OperationPipeline): Promise<void> => {
    if (pipeline.status !== "running") return
    setCancellingId(pipeline.id)
    try {
      if (pipeline.kind === OperationKind.AgentRun) {
        await api.cancelRun(pipeline.id)
      } else if (pipeline.kind === OperationKind.ProposerRun) {
        await api.cancelProposerRun(pipeline.id)
      }
    } catch {
      /* SSE refresh */
    } finally {
      setCancellingId(null)
    }
  }, [])

  const toggleStatus = useCallback((s: OperationStatus) => {
    setStatuses((prev) => {
      const n = new Set(prev)
      if (n.has(s)) n.delete(s)
      else n.add(s)
      return n
    })
  }, [])

  const togglePipeline = useCallback((id: string) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  const toggleActivity = useCallback((key: string) => {
    setActExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((s) => {
      const n = new Set(s)
      if (n.has(label)) n.delete(label)
      else n.add(label)
      return n
    })
  }, [])

  const needle = search.trim().toLowerCase()
  const serverSearchActive = needle.length >= 2

  const filtered = useMemo(
    () =>
      pipelines.filter((p) => {
        if (statuses.size > 0 && !statuses.has(p.status)) return false
        if (!serverSearchActive && needle && !matchesPipeline(p, needle)) return false
        return true
      }),
    [pipelines, statuses, needle, serverSearchActive],
  )

  const searchPending = serverSearchActive && loading

  useEffect(() => {
    if (!hasMore) return
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { root, rootMargin: "240px" },
    )
    obs.observe(target)
    return () => obs.disconnect()
  }, [hasMore, loadMore, filtered.length])

  const emptyMessage = useMemo(() => {
    if (error) return error
    if (pipelines.length === 0) return "No operations yet"
    if (statuses.size > 0) return "No operations match your filters"
    if (needle) return "No operations match your search"
    return "No operations yet"
  }, [error, pipelines.length, statuses.size, needle])

  return (
    <OperationLogModalsProvider>
      <div ref={rootRef} className="flex h-full flex-col overflow-hidden bg-canvas font-sans text-text">
        <ActivityLogToolbar
          kindView={kindView}
          setKindView={setKindView}
          statuses={statuses}
          toggleStatus={toggleStatus}
          clearStatuses={() => setStatuses(new Set())}
          search={search}
          setSearch={setSearch}
          searchPending={searchPending}
          filteredCount={filtered.length}
          totalCount={pipelines.length}
          compact={compact}
        />

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {loading && filtered.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading…
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <p className="py-16 text-center text-[13px] text-text-muted">{emptyMessage}</p>
          )}

          {filtered.length > 0 && (
            <ActivityList
              pipelines={filtered}
              compact={compact}
              expanded={expanded}
              togglePipeline={togglePipeline}
              actExpanded={actExpanded}
              toggleActivity={toggleActivity}
              collapsedDays={collapsedDays}
              toggleDay={toggleDay}
              onCancelPipeline={cancelPipeline}
              cancellingId={cancellingId}
            />
          )}

          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-8">
              {loadingMore && (
                <span className="flex items-center gap-2 text-[12px] text-text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  Loading more…
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </OperationLogModalsProvider>
  )
}
