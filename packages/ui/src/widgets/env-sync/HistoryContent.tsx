import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  SlidersHorizontal,
  View,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"

import { api, type SyncHistoryParams, type SyncHistoryPage, type SyncRunStatus } from "../../client/index"
import { DateField } from "../../components/DateField"
import {
  ActiveFilterChips,
  FilterField,
  FilterSheet,
  FilterToggles,
  type ActiveFilterChipModel,
} from "../../components/FilterSheet"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { SearchablePick } from "../../components/SearchablePick"
import { useMe } from "../../hooks/useMe"
import { useStore } from "../../state/store"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../lib/util"
import {
  WidgetToolbar,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import { EmptyHistory, Loading } from "./chrome"
import { DIFF, ENTITY_TYPES, dot } from "./constants"
import { formatPlanEntityLabel } from "./workflow"
import { HistoryPlanTables } from "./PlanTables"
import { SqlTraceModal } from "../sync/trace/SqlTraceModal"
import { hasSqlTraceContent, type SqlTraceFields } from "../sync/trace/sync-sql-trace"
import { JsonViewer } from "../../components/JsonViewer"

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300
const SQL_TRACE_PAGE = 50

type SyncRunItem = SyncHistoryPage["items"][number]
type SyncAuditEvent = Awaited<ReturnType<typeof api.syncHistoryDetail>>["audit"][number]
type RunStatus = SyncRunItem["status"]

type HistoryFilters = Omit<SyncHistoryParams, "page" | "pageSize">

const DEFAULT_FILTERS: HistoryFilters = { sort: "started_desc" }

const STATUS_OPTIONS: ListboxOption<SyncRunStatus>[] = [
  { value: "preview", label: "Preview" },
  { value: "started", label: "Executing" },
  { value: "success", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
  { value: "cancelled", label: "Cancelled" },
]

const SORT_OPTIONS: ListboxOption<NonNullable<HistoryFilters["sort"]>>[] = [
  { value: "started_desc", label: "Newest" },
  { value: "started_asc", label: "Oldest" },
  { value: "finished_desc", label: "Recent" },
  { value: "finished_asc", label: "Earliest" },
]

function entityLabel(run: SyncRunItem): string {
  const ref = `${run.entityType}#${run.entityId}`
  return run.entityDisplayName ? `${run.entityDisplayName} (${ref})` : ref
}

function runStatusTone(status: RunStatus): string {
  switch (status) {
    case "success":
      return DIFF.ins
    case "failed":
      return DIFF.del
    case "skipped":
      return "var(--color-warning)"
    case "started":
      return "var(--color-accent)"
    case "cancelled":
      return "var(--color-text-muted)"
    default:
      return "var(--color-text-muted)"
  }
}

function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "success":
      return "completed"
    case "failed":
      return "failed"
    case "skipped":
      return "skipped"
    case "started":
      return "executing"
    case "cancelled":
      return "cancelled"
    default:
      return "preview"
  }
}

function formatAuditAction(action: string): string {
  const map: Record<string, string> = {
    "sync.preview": "Preview",
    "sync.execute.start": "Execute started",
    "sync.execute.completed": "Execute completed",
    "sync.execute.skipped": "Execute skipped (audit gate)",
    "sync.execute.failed": "Execute failed",
    "sync.execute.cancelled": "Execute cancelled",
  }
  return map[action] ?? action
}

function countActiveFilters(filters: HistoryFilters, searchDraft: string): number {
  let count = 0
  if (searchDraft.trim()) count++
  if (filters.status?.length) count++
  if (filters.entityType?.trim()) count++
  if (filters.actorUpn?.trim()) count++
  if (filters.source?.trim()) count++
  if (filters.target?.trim()) count++
  if (filters.from?.trim()) count++
  if (filters.to?.trim()) count++
  if (filters.sort && filters.sort !== "started_desc") count++
  return count
}

export function HistoryContent({
  onOpen,
  onNotifyError,
}: {
  onOpen?: (planId: string) => void
  onNotifyError?: (message: string) => void
}) {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS)
  const [searchDraft, setSearchDraft] = useState("")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [data, setData] = useState<SyncHistoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [envOptions, setEnvOptions] = useState<ListboxOption<string>[]>([{ value: "", label: "Any" }])
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const entityTypeOptions = useMemo<ListboxOption<string>[]>(
    () => [
      { value: "", label: "Any" },
      ...ENTITY_TYPES.map((type) => ({ value: type, label: type })),
    ],
    [],
  )

  useEffect(() => {
    api
      .syncEnvironments()
      .then((envs) =>
        setEnvOptions([
          { value: "", label: "Any" },
          ...envs.map((env) => ({
            value: env.name,
            label: env.displayName.toUpperCase(),
            dot: dot(env.color),
          })),
        ]),
      )
      .catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  const activeFilterCount = useMemo(() => countActiveFilters(filters, searchDraft), [filters, searchDraft])
  const hasActiveFilters = activeFilterCount > 0

  const reload = useCallback(
    (nextPage = page, nextFilters = filters) => {
      setLoading(true)
      api
        .syncHistory({ page: nextPage, pageSize: PAGE_SIZE, ...nextFilters })
        .then((result) => {
          setData(result)
          setPage(result.page)
        })
        .catch((error) => {
          onNotifyError?.(error instanceof Error ? error.message : String(error))
        })
        .finally(() => setLoading(false))
    },
    [page, filters, onNotifyError],
  )

  useEffect(() => {
    reload(1, filters)
  }, [filters])

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setFilters((current) => {
        const nextQ = searchDraft.trim() || undefined
        if (current.q === nextQ) return current
        return { ...current, q: nextQ }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [searchDraft])

  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const syncHistoryRevision = useStore((s) => s.syncHistoryRevision)
  const syncFormPlanId = useStore((s) => s.envSyncForm.planId)
  const prevPlanIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (syncFormPlanId && syncFormPlanId !== prevPlanIdRef.current) {
      prevPlanIdRef.current = syncFormPlanId
      reload(1)
    }
  }, [syncFormPlanId, reload])

  useEffect(() => {
    if (agentSyncExecStarted) reload(1)
  }, [agentSyncExecStarted, reload])

  useEffect(() => {
    if (agentSyncExec) reload(page)
  }, [agentSyncExec, page, reload])

  useEffect(() => {
    if (syncHistoryRevision > 0) reload(page)
  }, [syncHistoryRevision, page, reload])

  useEffect(() => {
    const hasInFlight = data?.items.some((run) => run.status === "started")
    if (!hasInFlight) return
    const timer = setInterval(() => reload(page), 4000)
    return () => clearInterval(timer)
  }, [data?.items, page, reload])

  const filterBtnRef = useRef<HTMLButtonElement>(null)

  const patchFilters = (patch: Partial<HistoryFilters>): void => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  const clearFilters = () => {
    setSearchDraft("")
    setFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  const statusLabel = (status: SyncRunStatus): string =>
    STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    for (const status of filters.status ?? []) {
      chips.push({
        id: `status:${status}`,
        label: "Status",
        value: statusLabel(status),
        onRemove: () => {
          setFilters((current) => {
            const next = (current.status ?? []).filter((item) => item !== status)
            return { ...current, status: next.length > 0 ? next : undefined }
          })
          setPage(1)
        },
      })
    }
    if (filters.from?.trim()) {
      chips.push({
        id: "from",
        label: "From",
        value: filters.from,
        onRemove: () => patchFilters({ from: undefined }),
      })
    }
    if (filters.to?.trim()) {
      chips.push({
        id: "to",
        label: "To",
        value: filters.to,
        onRemove: () => patchFilters({ to: undefined }),
      })
    }
    if (filters.entityType?.trim()) {
      chips.push({
        id: "entity",
        label: "Entity",
        value: filters.entityType,
        onRemove: () => patchFilters({ entityType: undefined }),
      })
    }
    if (filters.actorUpn?.trim()) {
      chips.push({
        id: "user",
        label: "User",
        value: filters.actorUpn,
        onRemove: () => patchFilters({ actorUpn: undefined }),
      })
    }
    if (filters.source?.trim()) {
      chips.push({
        id: "source",
        label: "Source",
        value: filters.source,
        onRemove: () => patchFilters({ source: undefined }),
      })
    }
    if (filters.target?.trim()) {
      chips.push({
        id: "target",
        label: "Target",
        value: filters.target,
        onRemove: () => patchFilters({ target: undefined }),
      })
    }
    return chips
  }, [filters])

  if (loading && !data) return <Loading>Loading history…</Loading>

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.totalPages ?? 0
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <HistorySearchBar
        searchDraft={searchDraft}
        onSearchChange={setSearchDraft}
        sort={filters.sort ?? "started_desc"}
        onSortChange={(sort) => patchFilters({ sort })}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((value) => !value)}
        filterBtnRef={filterBtnRef}
        activeFilterCount={activeFilterCount}
        loading={loading}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        total={total}
        page={page}
        totalPages={totalPages}
        onPageChange={(nextPage) => reload(nextPage)}
      />

      <ActiveFilterChips chips={activeChips} onClear={hasActiveFilters ? clearFilters : undefined} />

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        anchorRef={filterBtnRef}
        footer={
          hasActiveFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-sm font-medium text-text-muted hover:text-text"
            >
              Clear all
            </button>
          ) : null
        }
      >
        <FilterField label="Status">
          <FilterToggles
            options={STATUS_OPTIONS}
            values={filters.status ?? []}
            onChange={(status) =>
              patchFilters({ status: status.length > 0 ? status : undefined })
            }
          />
        </FilterField>
        <div className="grid grid-cols-2 gap-3">
          <FilterField label="From">
            <DateField
              value={filters.from}
              onChange={(from) => patchFilters({ from })}
              placeholder="Pick date"
              ariaLabel="From"
              size="sm"
              className="w-full"
            />
          </FilterField>
          <FilterField label="To">
            <DateField
              value={filters.to}
              onChange={(to) => patchFilters({ to })}
              placeholder="Pick date"
              ariaLabel="To"
              size="sm"
              className="w-full"
            />
          </FilterField>
        </div>
        <FilterField label="Entity">
          <Listbox
            value={filters.entityType ?? ""}
            options={entityTypeOptions}
            onChange={(entityType) => patchFilters({ entityType: entityType || undefined })}
            size="sm"
            className="w-full listbox-control"
            ariaLabel="Entity"
            placeholder="Any"
            blankIsPlaceholder
          />
        </FilterField>
        <FilterField label="User">
          <SearchablePick
            value={filters.actorUpn ?? ""}
            options={[]}
            onChange={(actorUpn) => patchFilters({ actorUpn: actorUpn || undefined })}
            placeholder={isAdmin ? "UPN" : "Yours"}
            ariaLabel="User"
            disabled={!isAdmin}
            size="sm"
          />
        </FilterField>
        <div className="grid grid-cols-2 gap-3">
          <FilterField label="Source">
            <Listbox
              value={filters.source ?? ""}
              options={envOptions}
              onChange={(source) => patchFilters({ source: source || undefined })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Source"
              placeholder="Any"
              blankIsPlaceholder
            />
          </FilterField>
          <FilterField label="Target">
            <Listbox
              value={filters.target ?? ""}
              options={envOptions}
              onChange={(target) => patchFilters({ target: target || undefined })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Target"
              placeholder="Any"
              blankIsPlaceholder
            />
          </FilterField>
        </div>
      </FilterSheet>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {items.length === 0 ? (
          <EmptyHistory
            message={hasActiveFilters ? "No runs match your filters" : "No sync history yet"}
            action={
              hasActiveFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-sm text-accent hover:text-accent/80 transition-colors"
                >
                  Clear filters
                </button>
              ) : undefined
            }
          />
        ) : (
          items.map((run) => (
            <HistoryRunRow key={run.planId} run={run} onOpen={onOpen} onNotifyError={onNotifyError} />
          ))
        )}
      </div>
    </div>
  )
}

function HistorySearchBar({
  searchDraft,
  onSearchChange,
  sort,
  onSortChange,
  filtersOpen,
  onToggleFilters,
  filterBtnRef,
  activeFilterCount,
  loading,
  rangeStart,
  rangeEnd,
  total,
  page,
  totalPages,
  onPageChange,
}: {
  searchDraft: string
  onSearchChange: (value: string) => void
  sort: NonNullable<HistoryFilters["sort"]>
  onSortChange: (sort: NonNullable<HistoryFilters["sort"]>) => void
  filtersOpen: boolean
  onToggleFilters: () => void
  filterBtnRef: RefObject<HTMLButtonElement | null>
  activeFilterCount: number
  loading: boolean
  rangeStart: number
  rangeEnd: number
  total: number
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  return (
    <WidgetToolbar className="shrink-0 border-b border-border/40 !rounded-none !border-x-0 !border-t-0 !bg-transparent px-3 py-1.5">
      <WidgetToolbarSearch
        value={searchDraft}
        onChange={onSearchChange}
        placeholder="Search history…"
        onClear={() => onSearchChange("")}
      />
      <WidgetToolbarTrailing>
        <div className="w-[7.5rem] shrink-0">
          <Listbox
            value={sort}
            options={SORT_OPTIONS}
            onChange={onSortChange}
            size="sm"
            className="w-full listbox-control"
            ariaLabel="Sort"
          />
        </div>
        <span className="widget-toolbar__count hidden sm:inline-flex">
          <span className="widget-toolbar__count-filtered">
            {total === 0 ? "No runs" : `${rangeStart}–${rangeEnd}`}
          </span>
          {total > 0 && (
            <>
              <span className="widget-toolbar__count-sep">/</span>
              <span className="widget-toolbar__count-total">{total}</span>
            </>
          )}
        </span>
        <button
          type="button"
          disabled={page <= 1 || loading}
          onClick={() => onPageChange(page - 1)}
          className="widget-toolbar__icon-btn disabled:opacity-30"
          title="Previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="font-mono text-sm tabular-nums text-text-muted">
          {page}
          {totalPages > 0 ? `/${totalPages}` : ""}
        </span>
        <button
          type="button"
          disabled={page >= totalPages || loading}
          onClick={() => onPageChange(page + 1)}
          className="widget-toolbar__icon-btn disabled:opacity-30"
          title="Next page"
        >
          <ChevronRight size={14} />
        </button>
        <button
          ref={filterBtnRef}
          type="button"
          onClick={onToggleFilters}
          className={`widget-toolbar__icon-btn relative ${
            filtersOpen || activeFilterCount > 0 ? "text-accent" : ""
          }`}
          title={
            activeFilterCount > 0
              ? `Filters (${activeFilterCount} active)`
              : "Filters"
          }
          aria-pressed={filtersOpen}
        >
          <SlidersHorizontal size={14} />
          {activeFilterCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-mono font-medium leading-none text-text-on-accent">
              {activeFilterCount}
            </span>
          )}
        </button>
      </WidgetToolbarTrailing>
    </WidgetToolbar>
  )
}

function HistoryRunRow({
  run,
  onOpen,
  onNotifyError,
}: {
  run: SyncRunItem
  onOpen?: (planId: string) => void
  onNotifyError?: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [audit, setAudit] = useState<SyncAuditEvent[] | null>(null)
  const [sqlTrace, setSqlTrace] = useState<Awaited<ReturnType<typeof api.syncSqlTrace>> | null>(null)
  const [sqlTraceLoading, setSqlTraceLoading] = useState(false)
  const [sqlTraceLoadingMore, setSqlTraceLoadingMore] = useState(false)
  const planLoadFailedRef = useRef(false)
  const auditLoadFailedRef = useRef(false)
  const sqlTraceLoadFailedRef = useRef(false)
  const auditLoadedRef = useRef(false)
  const planLoadedRef = useRef(false)
  const sqlTraceLoadedRef = useRef(false)

  const totals = run.executeTotals ?? run.previewTotals
  const label = plan ? formatPlanEntityLabel(plan) : entityLabel(run)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    if (!auditLoadedRef.current && !auditLoadFailedRef.current) {
      auditLoadedRef.current = true
      api
        .syncHistoryDetail(run.planId)
        .then((detail) => {
          if (!cancelled) setAudit(detail.audit)
        })
        .catch((error) => {
          if (cancelled) return
          auditLoadFailedRef.current = true
          onNotifyError?.(`Could not load audit trail: ${error instanceof Error ? error.message : String(error)}`)
        })
    }

    if (run.planAvailable && !planLoadedRef.current && !planLoadFailedRef.current) {
      planLoadedRef.current = true
      setPlanLoading(true)
      api
        .syncPlan(run.planId)
        .then((next) => {
          if (cancelled || next.error) return
          setPlan(next)
        })
        .catch((error) => {
          if (cancelled) return
          planLoadFailedRef.current = true
          onNotifyError?.(`Could not load persisted plan: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (!cancelled) setPlanLoading(false)
        })
    }

    if (!sqlTraceLoadedRef.current && !sqlTraceLoadFailedRef.current) {
      sqlTraceLoadedRef.current = true
      setSqlTraceLoading(true)
      api
        .syncSqlTrace(run.planId, { limit: SQL_TRACE_PAGE, offset: 0 })
        .then((trace) => {
          if (!cancelled) setSqlTrace(trace)
        })
        .catch((error) => {
          if (cancelled) return
          sqlTraceLoadFailedRef.current = true
          onNotifyError?.(`Could not load SQL trace: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          if (!cancelled) setSqlTraceLoading(false)
        })
    }

    return () => {
      cancelled = true
    }
  }, [open, run.planId, run.planAvailable, onNotifyError])

  const loadMoreSqlTrace = useCallback(() => {
    if (!sqlTrace || sqlTraceLoadingMore || sqlTrace.count >= sqlTrace.total) return
    setSqlTraceLoadingMore(true)
    api
      .syncSqlTrace(run.planId, { limit: SQL_TRACE_PAGE, offset: sqlTrace.count })
      .then((page) => {
        setSqlTrace((prev) =>
          prev
            ? {
                ...page,
                items: [...prev.items, ...page.items],
                count: prev.items.length + page.items.length,
              }
            : page,
        )
      })
      .catch((error) => {
        onNotifyError?.(`Could not load more SQL trace: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setSqlTraceLoadingMore(false))
  }, [run.planId, sqlTrace, sqlTraceLoadingMore, onNotifyError])

  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-elevated/30 transition-colors text-sm"
      >
        {open ? (
          <ChevronDown size={13} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-text-muted shrink-0" />
        )}
        <span
          className="w-2 h-2 shrink-0 rounded-full"
          style={{ background: runStatusTone(run.status) }}
          title={run.status}
        />
        <span className="text-text font-mono truncate flex-1">{label}</span>
        <span className="text-text-muted font-mono flex items-center gap-1 shrink-0">
          {run.source}
          <ArrowRight size={10} className="opacity-60" />
          {run.target}
        </span>
        <span className="font-mono tabular-nums flex gap-2 shrink-0">
          {totals.insert > 0 && <span style={{ color: DIFF.ins }}>{totals.insert} ins</span>}
          {totals.update > 0 && <span style={{ color: DIFF.upd }}>{totals.update} upd</span>}
          {totals.delete > 0 && <span style={{ color: DIFF.del }}>{totals.delete} del</span>}
        </span>
        <span className="text-text-muted capitalize shrink-0">{runStatusLabel(run.status)}</span>
        <span className="text-text-muted flex items-center gap-1 shrink-0" title={formatHistoryDateTime(run.startedAt)}>
          <Clock size={11} />
          {timeAgo(run.finishedAt ?? run.startedAt)}
        </span>
      </button>

      {open && (
        <div className="px-3 py-2.5 bg-base/20 border-t border-border/30 space-y-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <code className="min-w-0 break-all text-sm font-mono text-text-muted">{run.planId}</code>
            {onOpen && run.planAvailable && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent/80 transition-colors shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(run.planId)
                }}
              >
                <View size={12} />
                Open in sync
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-text-muted">
            <MetaItem label="Actor" value={run.actorUpn ?? "—"} />
            <MetaSep />
            <MetaItem label="Route" value={`${run.source} → ${run.target}`} mono />
            <MetaSep />
            <MetaItem label="Started" value={formatHistoryDateTime(run.startedAt)} />
            {run.finishedAt && (
              <>
                <MetaSep />
                <MetaItem label="Finished" value={formatHistoryDateTime(run.finishedAt)} />
              </>
            )}
            {run.durationMs != null && (
              <>
                <MetaSep />
                <MetaItem label="Duration" value={`${(run.durationMs / 1000).toFixed(1)}s`} />
              </>
            )}
          </div>

          {run.error && (
            <div className="rounded-md border border-error/20 bg-error/5 px-2.5 py-1.5 text-sm font-mono leading-relaxed break-all text-error">
              {run.error}
            </div>
          )}

          <HistoryRunDetail
            plan={plan}
            planLoading={run.planAvailable && planLoading && !plan}
            audit={audit}
            sqlTrace={sqlTrace}
            sqlTraceLoading={sqlTraceLoading}
            sqlTraceLoadingMore={sqlTraceLoadingMore}
            onLoadMoreSql={loadMoreSqlTrace}
          />
        </div>
      )}
    </div>
  )
}

type SqlTracePage = NonNullable<Awaited<ReturnType<typeof api.syncSqlTrace>>>
type SqlTraceItem = SqlTracePage["items"][number]

type TimelineEntry =
  | { kind: "audit"; ts: string; event: SyncAuditEvent }
  | { kind: "sql"; ts: string; item: SqlTraceItem }

function buildHistoryTimeline(
  audit: SyncAuditEvent[] | null,
  sqlTrace: SqlTracePage | null,
): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const event of audit ?? []) {
    entries.push({ kind: "audit", ts: event.timestamp, event })
  }
  for (const item of sqlTrace?.items ?? []) {
    entries.push({ kind: "sql", ts: item.createdAt, item })
  }
  return entries.sort((a, b) => a.ts.localeCompare(b.ts))
}

function HistoryRunDetail({
  plan,
  planLoading,
  audit,
  sqlTrace,
  sqlTraceLoading,
  sqlTraceLoadingMore,
  onLoadMoreSql,
}: {
  plan: SyncPlan | null
  planLoading: boolean
  audit: SyncAuditEvent[] | null
  sqlTrace: SqlTracePage | null
  sqlTraceLoading: boolean
  sqlTraceLoadingMore: boolean
  onLoadMoreSql: () => void
}) {
  const [sqlModal, setSqlModal] = useState<SqlTraceFields | null>(null)
  const [expandedJson, setExpandedJson] = useState<string | null>(null)
  const timeline = useMemo(() => buildHistoryTimeline(audit, sqlTrace), [audit, sqlTrace])
  const showTimeline = sqlTraceLoading || timeline.length > 0

  return (
    <>
      <div className="rounded-md border border-border-subtle overflow-hidden">
        {planLoading && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted border-b border-border/30">
            <Loader2 size={12} className="animate-spin" />
            Loading persisted plan…
          </div>
        )}
        {plan && (
          <div className="px-3 py-2 border-b border-border/30">
            <HistoryPlanTables plan={plan} />
          </div>
        )}
        {showTimeline && (
          <div className="px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-sm font-medium text-text-muted">What happened</span>
              {!sqlTraceLoading && timeline.length > 0 && (
                <span className="text-sm font-mono text-text tabular-nums">{timeline.length} events</span>
              )}
            </div>
            {sqlTraceLoading && timeline.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-text-muted py-1">
                <Loader2 size={12} className="animate-spin" />
                Loading run timeline…
              </div>
            ) : (
              <div className="rounded-md border border-border-subtle overflow-hidden divide-y divide-border/30">
                {timeline.map((entry, index) => {
                  const key =
                    entry.kind === "audit"
                      ? `audit:${entry.event.action}:${entry.ts}:${index}`
                      : `sql:${entry.item.id}`
                  if (entry.kind === "audit") {
                    const failed = entry.event.action.endsWith(".failed")
                    const completed = entry.event.action.endsWith(".completed")
                    const tone = failed ? DIFF.del : completed ? DIFF.ins : undefined
                    const jsonKey = `${key}:json`
                    return (
                      <div key={key}>
                        <div className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-elevated/30 transition-colors">
                          <span className="font-medium shrink-0" style={tone ? { color: tone } : undefined}>
                            {formatAuditAction(entry.event.action)}
                          </span>
                          <span className="text-text-muted truncate min-w-0 flex-1">{entry.event.actor}</span>
                          <span className="text-text-muted font-mono tabular-nums shrink-0">
                            {formatHistoryTime(entry.ts)}
                          </span>
                          {entry.event.detail != null && (
                            <button
                              type="button"
                              className="text-sm text-accent hover:text-accent-hover shrink-0"
                              onClick={() => setExpandedJson((v) => (v === jsonKey ? null : jsonKey))}
                            >
                              {expandedJson === jsonKey ? "hide" : "detail"}
                            </button>
                          )}
                        </div>
                        {expandedJson === jsonKey && entry.event.detail != null && (
                          <div className="px-3 pb-2 border-t border-border/30 bg-base/20">
                            <JsonViewer value={entry.event.detail} label="detail" defaultExpandDepth={2} maxHeight={180} />
                          </div>
                        )}
                      </div>
                    )
                  }
                  const item = entry.item
                  const fields: SqlTraceFields = {
                    label: item.scope ? `${item.label} (${item.scope})` : item.label,
                    connection: item.connection,
                    sql: item.sqlPreview,
                    sqlLength: item.sqlLength,
                    sqlLogId: item.id,
                    rowCount: item.rowCount,
                    durationMs: item.durationMs,
                    error: item.error,
                  }
                  if (!hasSqlTraceContent(fields)) return null
                  const detail = [
                    item.connection,
                    item.durationMs != null ? `${item.durationMs}ms` : null,
                    item.rowCount != null ? `${item.rowCount} rows` : null,
                  ].filter(Boolean).join(" · ")
                  return (
                    <div key={key} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-elevated/30 transition-colors">
                      <span className="font-medium text-text shrink-0">SQL · {item.label}</span>
                      <span className="text-text-muted truncate min-w-0 flex-1">{detail}</span>
                      <span className="text-text-muted font-mono tabular-nums shrink-0">
                        {formatHistoryTime(entry.ts)}
                      </span>
                      <button
                        type="button"
                        className="text-sm text-accent hover:text-accent-hover shrink-0 font-mono"
                        onClick={() => setSqlModal(fields)}
                      >
                        SQL
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {sqlTrace && sqlTrace.count < sqlTrace.total && (
              <button
                type="button"
                className="mt-2 text-sm text-accent hover:text-accent-hover font-mono"
                disabled={sqlTraceLoadingMore}
                onClick={onLoadMoreSql}
              >
                {sqlTraceLoadingMore ? "Loading…" : `Load more SQL (${sqlTrace.count} / ${sqlTrace.total})`}
              </button>
            )}
          </div>
        )}
      </div>
      {sqlModal && <SqlTraceModal fields={sqlModal} onClose={() => setSqlModal(null)} />}
    </>
  )
}

function formatHistoryTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className="text-text-muted/45">{label}</span>
      <span className={`text-text truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </span>
  )
}

function MetaSep() {
  return <span className="text-text-muted/25 hidden sm:inline">·</span>
}

function formatHistoryDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
