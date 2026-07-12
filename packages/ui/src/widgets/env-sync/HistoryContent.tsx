import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  Search,
  SlidersHorizontal,
  View,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { api, type SyncHistoryParams, type SyncHistoryPage, type SyncRunStatus } from "../../api"
import { useMe } from "../../hooks/useMe"
import { useStore } from "../../store"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../util"
import { EmptyHistory, Loading } from "./chrome"
import { DIFF } from "./constants"
import { formatPlanEntityLabel } from "./workflow"
import { HistoryPlanTables } from "./PlanTables"

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

type SyncRunItem = SyncHistoryPage["items"][number]
type SyncAuditEvent = Awaited<ReturnType<typeof api.syncHistoryDetail>>["audit"][number]
type RunStatus = SyncRunItem["status"]

type HistoryFilters = Omit<SyncHistoryParams, "page" | "pageSize">

const DEFAULT_FILTERS: HistoryFilters = { sort: "started_desc" }

const STATUS_OPTIONS: Array<{ value: SyncRunStatus; label: string }> = [
  { value: "preview", label: "Preview" },
  { value: "started", label: "Executing" },
  { value: "success", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
]

const FILTER_INPUT =
  "w-full rounded-lg border border-border/50 bg-overlay-1/40 px-3 py-1.5 text-sm text-text placeholder:text-text-muted/45 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"

const SORT_OPTIONS: Array<{ value: NonNullable<HistoryFilters["sort"]>; label: string }> = [
  { value: "started_desc", label: "Newest first" },
  { value: "started_asc", label: "Oldest first" },
  { value: "finished_desc", label: "Recently finished" },
  { value: "finished_asc", label: "Earliest finished" },
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
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const clearFilters = () => {
    setSearchDraft("")
    setFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  const toggleStatus = (status: SyncRunStatus) => {
    setFilters((current) => {
      const selected = new Set(current.status ?? [])
      if (selected.has(status)) selected.delete(status)
      else selected.add(status)
      const next = [...selected]
      return { ...current, status: next.length > 0 ? next : undefined }
    })
    setPage(1)
  }

  if (loading && !data) return <Loading>Loading history…</Loading>

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = data?.totalPages ?? 0
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <HistorySearchBar
        searchDraft={searchDraft}
        onSearchChange={setSearchDraft}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((value) => !value)}
        activeFilterCount={activeFilterCount}
        loading={loading}
        onRefresh={() => reload(page)}
      />

      {filtersOpen && (
        <HistoryFiltersPanel
          filters={filters}
          isAdmin={isAdmin}
          onFiltersChange={(patch) => {
            setFilters((current) => ({ ...current, ...patch }))
            setPage(1)
          }}
          selectedStatuses={filters.status ?? []}
          onToggleStatus={toggleStatus}
          onClear={clearFilters}
          hasActiveFilters={hasActiveFilters}
        />
      )}

      <div className="flex shrink-0 items-center justify-between text-sm text-text-muted px-4 py-2 border-b border-border/40 gap-3">
        <span>{total === 0 ? "No runs" : `${rangeStart}–${rangeEnd} of ${total}`}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => reload(page - 1)}
            className="p-1 rounded hover:text-text disabled:opacity-30"
            title="Previous page"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="font-mono text-xs tabular-nums">
            {page}
            {totalPages > 0 ? ` / ${totalPages}` : ""}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => reload(page + 1)}
            className="p-1 rounded hover:text-text disabled:opacity-30"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyHistory
          message={hasActiveFilters ? "No runs match your filters" : "No sync history yet"}
          action={
            hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs text-accent hover:text-accent/80 transition-colors"
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
  )
}

function HistorySearchBar({
  searchDraft,
  onSearchChange,
  filtersOpen,
  onToggleFilters,
  activeFilterCount,
  loading,
  onRefresh,
}: {
  searchDraft: string
  onSearchChange: (value: string) => void
  filtersOpen: boolean
  onToggleFilters: () => void
  activeFilterCount: number
  loading: boolean
  onRefresh: () => void
}) {
  return (
    <div className="shrink-0 border-b border-border/40 px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <label className="relative flex-1 min-w-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted/50 pointer-events-none" />
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search entity, route, user, plan id…"
            className="w-full rounded-lg border border-border/50 bg-overlay-1/40 pl-9 pr-3 py-2 text-sm text-text placeholder:text-text-muted/45 focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
          />
        </label>
        <button
          type="button"
          onClick={onToggleFilters}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
            filtersOpen || activeFilterCount > 0
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-border/50 text-text-muted hover:text-text hover:bg-elevated/30"
          }`}
          title="Filters"
        >
          <SlidersHorizontal size={14} />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
              {activeFilterCount}
            </span>
          )}
          {filtersOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="p-2 rounded-lg border border-border/50 text-text-muted hover:text-text hover:bg-elevated/30"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>
      <p className="text-[11px] text-text-muted/55">
        Persisted preview and execution history — filter by user, status, route, or date range.
      </p>
    </div>
  )
}

function HistoryFiltersPanel({
  filters,
  isAdmin,
  onFiltersChange,
  selectedStatuses,
  onToggleStatus,
  onClear,
  hasActiveFilters,
}: {
  filters: HistoryFilters
  isAdmin: boolean
  onFiltersChange: (patch: Partial<HistoryFilters>) => void
  selectedStatuses: SyncRunStatus[]
  onToggleStatus: (status: SyncRunStatus) => void
  onClear: () => void
  hasActiveFilters: boolean
}) {
  return (
    <div className="shrink-0 border-b border-border/40 px-4 py-3 bg-base/20 space-y-3">
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted/55">Status</div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((option) => {
            const active = selectedStatuses.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onToggleStatus(option.value)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border/50 text-text-muted hover:text-text hover:bg-elevated/30"
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HistoryFilterField label="From">
          <input
            type="date"
            value={filters.from ?? ""}
            onChange={(event) => onFiltersChange({ from: event.target.value || undefined })}
            className={FILTER_INPUT}
          />
        </HistoryFilterField>
        <HistoryFilterField label="To">
          <input
            type="date"
            value={filters.to ?? ""}
            onChange={(event) => onFiltersChange({ to: event.target.value || undefined })}
            className={FILTER_INPUT}
          />
        </HistoryFilterField>
        <HistoryFilterField label="Sort">
          <select
            value={filters.sort ?? "started_desc"}
            onChange={(event) =>
              onFiltersChange({ sort: event.target.value as NonNullable<HistoryFilters["sort"]> })
            }
            className={FILTER_INPUT}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </HistoryFilterField>
        <HistoryFilterField label="Entity type">
          <input
            type="text"
            value={filters.entityType ?? ""}
            onChange={(event) => onFiltersChange({ entityType: event.target.value || undefined })}
            placeholder="e.g. contract"
            className={FILTER_INPUT}
          />
        </HistoryFilterField>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HistoryFilterField label={isAdmin ? "User (UPN)" : "User"}>
          <input
            type="text"
            value={filters.actorUpn ?? ""}
            onChange={(event) => onFiltersChange({ actorUpn: event.target.value || undefined })}
            placeholder={isAdmin ? "Filter by UPN" : "Your runs only"}
            disabled={!isAdmin}
            className={`${FILTER_INPUT} disabled:opacity-50`}
          />
        </HistoryFilterField>
        <HistoryFilterField label="Source">
          <input
            type="text"
            value={filters.source ?? ""}
            onChange={(event) => onFiltersChange({ source: event.target.value || undefined })}
            placeholder="e.g. dev"
            className={FILTER_INPUT}
          />
        </HistoryFilterField>
        <HistoryFilterField label="Target">
          <input
            type="text"
            value={filters.target ?? ""}
            onChange={(event) => onFiltersChange({ target: event.target.value || undefined })}
            placeholder="e.g. uat"
            className={FILTER_INPUT}
          />
        </HistoryFilterField>
        <div className="flex items-end">
          {hasActiveFilters && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1 rounded-lg border border-border/50 px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-elevated/30 transition-colors"
            >
              <X size={12} />
              Clear all
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryFilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 min-w-0">
      <span className="text-[11px] uppercase tracking-[0.14em] text-text-muted/55">{label}</span>
      {children}
    </label>
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
  const [audit, setAudit] = useState<SyncAuditEvent[] | null>(null)
  const planLoadFailedRef = useRef(false)
  const auditLoadFailedRef = useRef(false)

  const totals = run.executeTotals ?? run.previewTotals
  const label = plan ? formatPlanEntityLabel(plan) : entityLabel(run)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    if (!audit && !auditLoadFailedRef.current) {
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

    if (run.planAvailable && !plan && !planLoadFailedRef.current) {
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
    }

    return () => {
      cancelled = true
    }
  }, [open, run.planId, run.planAvailable, plan, audit, onNotifyError])

  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors text-sm"
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
        <div className="px-4 py-3 bg-base/30 border-t border-border/30 text-sm space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-text-muted/50 font-mono min-w-0">
              <span className="shrink-0">plan</span>
              <span className="text-text-muted truncate">{run.planId}</span>
            </div>
            {onOpen && run.planAvailable && (
              <button
                type="button"
                className="text-text-muted hover:text-accent/80 transition-colors shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(run.planId)
                }}
                title="View plan"
              >
                <View size={16} />
              </button>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <HistoryKv label="Entity" value={label} />
            <HistoryKv label="Route" value={`${run.source} → ${run.target}`} />
            <HistoryKv label="Actor" value={run.actorUpn ?? "—"} />
            <HistoryKv label="Started" value={formatHistoryDateTime(run.startedAt)} />
            {run.finishedAt && <HistoryKv label="Finished" value={formatHistoryDateTime(run.finishedAt)} />}
            {run.durationMs != null && (
              <HistoryKv label="Duration" value={`${(run.durationMs / 1000).toFixed(1)}s`} />
            )}
          </div>

          {run.error && (
            <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs font-mono break-all text-error">
              {run.error}
            </div>
          )}

          {plan && (
            <div className="rounded-lg border border-border-subtle overflow-hidden">
              <div className="max-h-[28rem] overflow-y-auto">
                <HistoryPlanTables plan={plan} />
              </div>
            </div>
          )}

          {audit && audit.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted/50">Audit</div>
              {audit.map((event, index) => (
                <HistoryAuditRow key={`${event.action}:${event.timestamp}:${index}`} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryAuditRow({ event }: { event: SyncAuditEvent }) {
  const [jsonOpen, setJsonOpen] = useState(false)
  const failed = event.action.endsWith(".failed")
  const completed = event.action.endsWith(".completed")
  const actionColor = failed ? DIFF.del : completed ? DIFF.ins : undefined

  return (
    <div className="rounded border border-border-subtle bg-overlay-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-medium shrink-0" style={actionColor ? { color: actionColor } : undefined}>
          {formatAuditAction(event.action)}
        </span>
        <span className="text-xs text-text-muted truncate">{event.actor}</span>
        <span className="flex-1" />
        <span className="text-xs text-text-muted/40 font-mono tabular-nums">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
        {event.detail != null && (
          <button
            type="button"
            onClick={() => setJsonOpen((value) => !value)}
            className="text-xs text-text-muted/40 hover:text-text-muted px-1 py-0.5 rounded hover:bg-elevated transition-colors"
          >
            {jsonOpen ? "hide" : "json"}
          </button>
        )}
      </div>
      {jsonOpen && event.detail != null && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <pre className="text-xs text-text-muted/60 font-mono whitespace-pre-wrap break-all leading-relaxed pt-1.5 max-h-48 overflow-y-auto show-scrollbar">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function HistoryKv({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-overlay-1/50 px-3 py-2 min-w-0">
      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted/55">{label}</div>
      <div className="mt-1 text-sm text-text font-mono leading-5 break-all">{value}</div>
    </div>
  )
}

function formatHistoryDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
