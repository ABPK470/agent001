/**
 * AuditModal — admin platform-wide audit browser.
 *
 * Queries persistent audit_log across all runs and admin scopes
 * (not the in-memory active-session trail). Supports time window,
 * user (UPN), scope, action filters + CSV/JSON export.
 */

import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  api,
  type AdminAuditFilterOptions,
  type AdminAuditItem,
  type AdminAuditParams,
  type AdminAuditSort,
} from "../../client/index"
import { ModalShell } from "../entity-registry/ModalShell"
import { MODAL_ADMIN_PANEL } from "../entity-registry/modal-overlay"
import { DateField } from "../../components/DateField"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalSearchField } from "../../components/ModalSearchField"

const PAGE_SIZE = 50

const SCOPE_OPTIONS: ListboxOption<string>[] = [
  { value: "", label: "All scopes" },
  { value: "run", label: "Agent runs" },
  { value: "admin", label: "Admin / platform" },
]

const SORT_OPTIONS: ListboxOption<AdminAuditSort>[] = [
  { value: "timestamp_desc", label: "Newest first" },
  { value: "timestamp_asc", label: "Oldest first" },
]

const EMPTY_FILTERS: Omit<AdminAuditParams, "page" | "pageSize"> = {
  q: "",
  scopeType: "",
  scopeId: "",
  user: "",
  action: "",
  runId: "",
  threadId: "",
  from: "",
  to: "",
  sort: "timestamp_desc",
}

function actionTone(action: string): string {
  if (action.includes("blocked") || action.includes("denied")) return "text-error"
  if (action.includes("completed") || action.includes("success")) return "text-success"
  if (action.includes("failed") || action.includes("error")) return "text-warning"
  return "text-text"
}

function formatWhen(ts: string): string {
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : `${ts}Z`)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-faint">{label}</span>
      {children}
    </label>
  )
}

export function AuditModal({ onClose }: { onClose: () => void }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [draftQ, setDraftQ] = useState("")
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AdminAuditItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [options, setOptions] = useState<AdminAuditFilterOptions>({
    users: [],
    scopeIds: [],
    actions: [],
  })

  useEffect(() => {
    api.adminAuditOptions().then(setOptions).catch(() => {})
  }, [])

  const queryParams = useMemo<AdminAuditParams>(
    () => ({
      ...filters,
      q: draftQ.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
      scopeType: filters.scopeType || undefined,
      scopeId: filters.scopeId || undefined,
      user: filters.user || undefined,
      action: filters.action || undefined,
      runId: filters.runId || undefined,
      threadId: filters.threadId || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    }),
    [filters, draftQ, page],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listAdminAudit(queryParams)
      setItems(data.items)
      setTotal(data.total)
      setTotalPages(data.totalPages)
      setExpanded(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log")
      setItems([])
      setTotal(0)
      setTotalPages(1)
    } finally {
      setLoading(false)
    }
  }, [queryParams])

  useEffect(() => {
    void load()
  }, [load])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (draftQ.trim()) n++
    if (filters.scopeType) n++
    if (filters.scopeId) n++
    if (filters.user) n++
    if (filters.action) n++
    if (filters.runId) n++
    if (filters.threadId) n++
    if (filters.from) n++
    if (filters.to) n++
    return n
  }, [draftQ, filters])

  function patchFilters(patch: Partial<typeof EMPTY_FILTERS>) {
    setFilters((prev) => ({ ...prev, ...patch }))
    setPage(1)
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS)
    setDraftQ("")
    setPage(1)
  }

  async function handleExport(format: "csv" | "json") {
    setExporting(true)
    try {
      await api.exportAdminAudit({ ...queryParams, page: undefined, pageSize: undefined, format })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const userOptions: ListboxOption<string>[] = useMemo(
    () => [
      { value: "", label: "All users" },
      ...options.users.map((u) => ({
        value: u.upn,
        label: u.role === "admin" ? `${u.upn} · Admin` : u.upn,
      })),
    ],
    [options.users],
  )
  const scopeIdOptions: ListboxOption<string>[] = useMemo(
    () => [
      { value: "", label: "Any scope id" },
      ...options.scopeIds.map((id) => ({ value: id, label: id })),
    ],
    [options.scopeIds],
  )
  const actionOptions: ListboxOption<string>[] = useMemo(
    () => [
      { value: "", label: "Any action" },
      ...options.actions.map((action) => ({ value: action, label: action })),
    ],
    [options.actions],
  )

  return (
    <ModalShell
      title="Audit"
      subtitle="Platform-wide immutable log — agent runs, policy decisions, and admin mutations across all users and threads."
      icon={<Scale size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={MODAL_ADMIN_PANEL}
      size="default"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[13px] text-text-muted">
            {loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "entry" : "entries"}`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-hover hover:text-text disabled:opacity-30"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[5rem] text-center font-mono text-[12px] text-text-muted">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-hover hover:text-text disabled:opacity-30"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-6 py-3">
          <div className="min-w-0 flex-1">
            <ModalSearchField
              value={draftQ}
              onChange={(value) => {
                setDraftQ(value)
                setPage(1)
              }}
              placeholder="Search action, user, detail, run, goal…"
              aria-label="Search audit log"
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className={`relative flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle text-text-muted transition-colors hover:bg-overlay-hover hover:text-text ${
              filtersOpen || activeFilterCount > 0 ? "text-accent" : ""
            }`}
            title={activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : "Filters"}
            aria-pressed={filtersOpen}
          >
            <SlidersHorizontal size={15} />
            {activeFilterCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-mono font-medium leading-none text-text-on-accent">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            disabled={exporting || total === 0}
            onClick={() => void handleExport("csv")}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[13px] text-text-secondary transition-colors hover:bg-overlay-hover hover:text-text disabled:opacity-30"
            title="Export filtered results as CSV"
          >
            <Download size={14} />
            CSV
          </button>
          <button
            type="button"
            disabled={exporting || total === 0}
            onClick={() => void handleExport("json")}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[13px] text-text-secondary transition-colors hover:bg-overlay-hover hover:text-text disabled:opacity-30"
            title="Export filtered results as JSON"
          >
            <Download size={14} />
            JSON
          </button>
        </div>

        {filtersOpen && (
          <div className="shrink-0 space-y-3 border-b border-border-subtle bg-base/30 px-6 py-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FilterField label="From">
                <DateField
                  value={filters.from}
                  onChange={(from) => patchFilters({ from })}
                  placeholder="Any start"
                  ariaLabel="Filter from date"
                  size="sm"
                  className="w-full"
                />
              </FilterField>
              <FilterField label="To">
                <DateField
                  value={filters.to}
                  onChange={(to) => patchFilters({ to })}
                  placeholder="Any end"
                  ariaLabel="Filter to date"
                  size="sm"
                  className="w-full"
                />
              </FilterField>
              <FilterField label="User">
                <Listbox
                  value={filters.user ?? ""}
                  options={userOptions}
                  onChange={(user) => patchFilters({ user })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by user"
                  placeholder="All users"
                />
              </FilterField>
              <FilterField label="Scope">
                <Listbox
                  value={filters.scopeType ?? ""}
                  options={SCOPE_OPTIONS}
                  onChange={(scopeType) =>
                    patchFilters({ scopeType: scopeType as AdminAuditParams["scopeType"] })
                  }
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by scope type"
                />
              </FilterField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FilterField label="Scope id">
                <Listbox
                  value={filters.scopeId ?? ""}
                  options={scopeIdOptions}
                  onChange={(scopeId) => patchFilters({ scopeId })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by scope id"
                />
              </FilterField>
              <FilterField label="Action">
                <Listbox
                  value={filters.action ?? ""}
                  options={actionOptions}
                  onChange={(action) => patchFilters({ action })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by action"
                />
              </FilterField>
              <FilterField label="Sort">
                <Listbox
                  value={filters.sort ?? "timestamp_desc"}
                  options={SORT_OPTIONS}
                  onChange={(sort) => patchFilters({ sort })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Sort order"
                />
              </FilterField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FilterField label="Run id">
                <input
                  value={filters.runId ?? ""}
                  onChange={(e) => patchFilters({ runId: e.target.value })}
                  placeholder="Exact run id"
                  className="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-overlay-2"
                />
              </FilterField>
              <FilterField label="Thread id">
                <input
                  value={filters.threadId ?? ""}
                  onChange={(e) => patchFilters({ threadId: e.target.value })}
                  placeholder="Exact thread id"
                  className="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-overlay-2"
                />
              </FilterField>
            </div>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text"
              >
                <X size={12} />
                Clear filters
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3 show-scrollbar">
          {error ? (
            <EmptyState icon={AlertCircle} message={error} className="py-10" />
          ) : loading && items.length === 0 ? (
            <EmptyState icon={Loader2} message="Loading audit log…" className="py-10 [&_svg]:animate-spin" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Scale}
              message="No audit entries match these filters."
              detail={activeFilterCount > 0 ? "Try clearing or widening your filters." : undefined}
              className="py-10"
            />
          ) : (
            <div className="space-y-0.5">
              {items.map((entry) => {
                const open = expanded === entry.id
                const detailKeys = Object.keys(entry.detail)
                return (
                  <div key={entry.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-overlay-2"
                      onClick={() => setExpanded(open ? null : entry.id)}
                    >
                      {detailKeys.length > 0 ? (
                        open ? (
                          <ChevronDown size={14} className="mt-0.5 shrink-0 text-text-muted" />
                        ) : (
                          <ChevronRight size={14} className="mt-0.5 shrink-0 text-text-muted" />
                        )
                      ) : (
                        <span className="mt-0.5 w-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="shrink-0 font-mono text-[12px] text-text-muted">
                            {formatWhen(entry.timestamp)}
                          </span>
                          <span className="shrink-0 rounded bg-overlay-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">
                            {entry.scopeType}
                            {entry.scopeId ? ` · ${entry.scopeId}` : ""}
                          </span>
                          {entry.user && (
                            <span className="shrink-0 text-text-secondary">{entry.user}</span>
                          )}
                          <span className={`font-medium ${actionTone(entry.action)}`}>{entry.action}</span>
                        </div>
                        {(entry.threadTitle || entry.run?.goal) && (
                          <div className="mt-1 truncate text-[12px] text-text-muted">
                            {entry.threadTitle && (
                              <span className="mr-2 text-text-secondary">{entry.threadTitle}</span>
                            )}
                            {entry.run?.goal && <span className="opacity-80">{entry.run.goal}</span>}
                          </div>
                        )}
                      </div>
                    </button>
                    {open && detailKeys.length > 0 && (
                      <div className="mb-2 ml-8 space-y-1 rounded-xl border border-border-subtle bg-overlay-2 px-3 py-2 font-mono text-[12px] text-text-secondary">
                        {entry.runId && (
                          <div className="flex gap-2">
                            <span className="shrink-0 text-text-muted">runId:</span>
                            <span className="break-all">{entry.runId}</span>
                          </div>
                        )}
                        {entry.threadId && (
                          <div className="flex gap-2">
                            <span className="shrink-0 text-text-muted">threadId:</span>
                            <span className="break-all">{entry.threadId}</span>
                          </div>
                        )}
                        {Object.entries(entry.detail).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="shrink-0 text-text-muted">{k}:</span>
                            <span className="break-all">
                              {typeof v === "string" ? v : JSON.stringify(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
