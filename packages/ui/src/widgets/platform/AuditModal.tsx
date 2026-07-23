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
  ChevronRight,
  Download,
  Loader2,
  Scale,
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
import { DateField } from "../../components/DateField"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalShell } from "../entity-registry/ModalShell"
import {
  AdminBrowseFilterField,
  AdminBrowseFiltersPanel,
  AdminBrowsePaginationFooter,
  AdminBrowseToolbar,
} from "./admin-browse-chrome"
import { AdminBrowseDetailPanel, buildBrowseDetailEntries } from "./admin-browse-detail"

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
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [options, setOptions] = useState<AdminAuditFilterOptions>({
    users: [],
    scopeIds: [],
    actions: [],
  })

  useEffect(() => {
    api.adminAuditOptions().then(setOptions).catch((err: unknown) => { console.error("[mia]", err) })
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

  function onSearchChange(value: string) {
    setDraftQ(value)
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
      size="focus"
      footer={
        <AdminBrowsePaginationFooter
          loading={loading}
          total={total}
          singular="entry"
          plural="entries"
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <AdminBrowseToolbar
          search={draftQ}
          onSearchChange={onSearchChange}
          searchPlaceholder="Search action, user, detail, run, goal…"
          searchAriaLabel="Search audit log"
          filtersOpen={filtersOpen}
          onToggleFilters={() => setFiltersOpen((v) => !v)}
          activeFilterCount={activeFilterCount}
          onRefresh={() => void load()}
          loading={loading}
          trailing={
            <>
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
            </>
          }
        />

        {filtersOpen && (
          <AdminBrowseFiltersPanel>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <AdminBrowseFilterField label="From">
                <DateField
                  value={filters.from ?? ""}
                  onChange={(from) => patchFilters({ from })}
                  placeholder="Any start"
                  ariaLabel="Filter from date"
                  size="sm"
                  className="w-full"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="To">
                <DateField
                  value={filters.to ?? ""}
                  onChange={(to) => patchFilters({ to })}
                  placeholder="Any end"
                  ariaLabel="Filter to date"
                  size="sm"
                  className="w-full"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="User">
                <Listbox
                  value={filters.user ?? ""}
                  options={userOptions}
                  onChange={(user) => patchFilters({ user })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by user"
                  placeholder="All users"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="Scope">
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
              </AdminBrowseFilterField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <AdminBrowseFilterField label="Scope id">
                <Listbox
                  value={filters.scopeId ?? ""}
                  options={scopeIdOptions}
                  onChange={(scopeId) => patchFilters({ scopeId })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by scope id"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="Action">
                <Listbox
                  value={filters.action ?? ""}
                  options={actionOptions}
                  onChange={(action) => patchFilters({ action })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Filter by action"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="Sort">
                <Listbox
                  value={filters.sort ?? "timestamp_desc"}
                  options={SORT_OPTIONS}
                  onChange={(sort) => patchFilters({ sort })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Sort order"
                />
              </AdminBrowseFilterField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <AdminBrowseFilterField label="Run id">
                <input
                  value={filters.runId ?? ""}
                  onChange={(e) => patchFilters({ runId: e.target.value })}
                  placeholder="Exact run id"
                  className="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-overlay-2"
                />
              </AdminBrowseFilterField>
              <AdminBrowseFilterField label="Thread id">
                <input
                  value={filters.threadId ?? ""}
                  onChange={(e) => patchFilters({ threadId: e.target.value })}
                  placeholder="Exact thread id"
                  className="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-overlay-2"
                />
              </AdminBrowseFilterField>
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
          </AdminBrowseFiltersPanel>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-3 show-scrollbar">
          {error ? (
            <EmptyState icon={AlertCircle} message={error} />
          ) : loading && items.length === 0 ? (
            <EmptyState icon={Loader2} message="Loading audit log…" className="[&_svg]:animate-spin" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Scale}
              message="No audit entries match these filters."
              detail={activeFilterCount > 0 ? "Try clearing or widening your filters." : undefined}
            />
          ) : (
            <div className="space-y-0.5">
              {items.map((entry) => {
                const entries = buildBrowseDetailEntries(entry.detail, {
                  runId: entry.runId,
                  threadId: entry.threadId,
                })
                const open = expanded === entry.id
                const hasDetail = entries.length > 0
                return (
                  <div key={entry.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-overlay-2"
                      onClick={() => {
                        if (!hasDetail) return
                        setExpanded(open ? null : entry.id)
                      }}
                    >
                      {hasDetail ? (
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
                    {open && hasDetail ? <AdminBrowseDetailPanel entries={entries} /> : null}
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
