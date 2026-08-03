/**
 * UsageModal — admin token browser.
 * Same filter dialect as Sync History / Catalog versions / Event Stream:
 * BrowseStrip → ActiveFilterChips → FilterSheet popover (not an inline filter grid).
 */

import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Hash,
  Loader2,
  MessageSquare,
  Zap,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  api,
  type UsageFilterOptions,
  type UsageItem,
  type UsageParams,
  type UsageSort,
  type UsageTotalsWire,
} from "../../client/index"
import { DateField } from "../../components/DateField"
import { EmptyState } from "../../components/EmptyState"
import {
  ActiveFilterChips,
  FilterField,
  FilterSheet,
  type ActiveFilterChipModel,
} from "../../components/FilterSheet"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalShell } from "../entity-registry/ModalShell"
import {
  AdminBrowsePaginationFooter,
  AdminBrowseToolbar,
} from "./admin-browse-chrome"
import { AdminBrowseDetailPanel, buildBrowseDetailEntries } from "./admin-browse-detail"

const PAGE_SIZE = 50

const SORT_OPTIONS: ListboxOption<UsageSort>[] = [
  { value: "created_desc", label: "Newest first" },
  { value: "created_asc", label: "Oldest first" },
  { value: "tokens_desc", label: "Most tokens" },
  { value: "tokens_asc", label: "Least tokens" },
]

const EMPTY_FILTERS: Omit<UsageParams, "page" | "pageSize" | "q"> = {
  user: "",
  model: "",
  from: "",
  to: "",
  sort: "created_desc",
}

const EMPTY_TOTALS: UsageTotalsWire = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  llmCalls: 0,
  runCount: 0,
  completedRuns: 0,
  failedRuns: 0,
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
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

function statusTone(status: string | null): string {
  if (!status) return "text-text-muted"
  if (status === "completed") return "text-success"
  if (status === "failed" || status === "crashed") return "text-error"
  if (status === "cancelled") return "text-warning"
  return "text-text-secondary"
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [draftQ, setDraftQ] = useState("")
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<UsageItem[]>([])
  const [totals, setTotals] = useState<UsageTotalsWire>(EMPTY_TOTALS)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [options, setOptions] = useState<UsageFilterOptions>({ users: [], models: [] })
  const filterBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    api.usageOptions().then(setOptions).catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  const queryParams = useMemo<UsageParams>(
    () => ({
      ...filters,
      q: draftQ.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
      user: filters.user || undefined,
      model: filters.model || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    }),
    [filters, draftQ, page],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getUsage(queryParams)
      setItems(data.items)
      setTotals(data.totals)
      setTotal(data.total)
      setTotalPages(data.totalPages)
      setExpanded(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load usage")
      setItems([])
      setTotals(EMPTY_TOTALS)
      setTotal(0)
      setTotalPages(1)
    } finally {
      setLoading(false)
    }
  }, [queryParams])

  useEffect(() => {
    void load().catch((err: unknown) => { console.error("[mia]", err) })
  }, [load])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filters.user) n++
    if (filters.model) n++
    if (filters.from) n++
    if (filters.to) n++
    return n
  }, [filters])

  const hasActiveFilters = activeFilterCount > 0

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
  const modelOptions: ListboxOption<string>[] = useMemo(
    () => [
      { value: "", label: "All models" },
      ...options.models.map((model) => ({ value: model, label: model })),
    ],
    [options.models],
  )

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    if (filters.from?.trim()) {
      chips.push({
        id: "from",
        label: "From",
        value: filters.from,
        onRemove: () => patchFilters({ from: "" }),
      })
    }
    if (filters.to?.trim()) {
      chips.push({
        id: "to",
        label: "To",
        value: filters.to,
        onRemove: () => patchFilters({ to: "" }),
      })
    }
    if (filters.user?.trim()) {
      chips.push({
        id: "user",
        label: "User",
        value: filters.user,
        onRemove: () => patchFilters({ user: "" }),
      })
    }
    if (filters.model?.trim()) {
      chips.push({
        id: "model",
        label: "Model",
        value: filters.model,
        onRemove: () => patchFilters({ model: "" }),
      })
    }
    return chips
  }, [filters])

  return (
    <ModalShell
      title="Token Usage"
      subtitle="Token consumption from agent runs on this instance. KPIs match the active filters."
      icon={<Activity size={20} className="text-text-muted" />}
      onClose={onClose}
      size="focus"
      footer={
        <AdminBrowsePaginationFooter
          loading={loading}
          total={total}
          singular="run"
          plural="runs"
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-border-subtle px-6 py-3 sm:grid-cols-4">
          <StatCard icon={<Zap size={15} />} label="Total tokens" value={formatNumber(totals.totalTokens)} />
          <StatCard
            icon={<MessageSquare size={15} />}
            label="Prompt"
            value={formatNumber(totals.promptTokens)}
          />
          <StatCard
            icon={<MessageSquare size={15} />}
            label="Completion"
            value={formatNumber(totals.completionTokens)}
          />
          <StatCard
            icon={<Hash size={15} />}
            label="LLM calls"
            value={formatNumber(totals.llmCalls)}
            hint={`${totals.completedRuns} ok · ${totals.failedRuns} failed`}
          />
        </div>

        <AdminBrowseToolbar
          search={draftQ}
          onSearchChange={onSearchChange}
          searchPlaceholder="Search run, user, goal, model, thread…"
          searchAriaLabel="Search token usage"
          filtersOpen={filtersOpen}
          onToggleFilters={() => setFiltersOpen((v) => !v)}
          activeFilterCount={activeFilterCount}
          onRefresh={() => void load().catch((err: unknown) => { console.error("[mia]", err) })}
          loading={loading}
          filterBtnRef={filterBtnRef}
          trailing={(
            <div className="w-[8.5rem] shrink-0">
              <Listbox
                value={filters.sort ?? "created_desc"}
                options={SORT_OPTIONS}
                onChange={(sort) => patchFilters({ sort })}
                size="sm"
                className="w-full listbox-control"
                ariaLabel="Sort order"
              />
            </div>
          )}
        />

        {activeChips.length > 0 && (
          <div className="px-6">
            <ActiveFilterChips
              chips={activeChips}
              onClear={hasActiveFilters ? clearFilters : undefined}
            />
          </div>
        )}

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
          <div className="grid grid-cols-2 gap-3">
            <FilterField label="From">
              <DateField
                value={filters.from ?? ""}
                onChange={(from) => patchFilters({ from })}
                placeholder="Pick date"
                ariaLabel="From"
                size="sm"
                className="w-full"
              />
            </FilterField>
            <FilterField label="To">
              <DateField
                value={filters.to ?? ""}
                onChange={(to) => patchFilters({ to })}
                placeholder="Pick date"
                ariaLabel="To"
                size="sm"
                className="w-full"
              />
            </FilterField>
          </div>
          <FilterField label="User">
            <Listbox
              value={filters.user ?? ""}
              options={userOptions}
              onChange={(user) => patchFilters({ user })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="User"
              placeholder="All users"
              blankIsPlaceholder
            />
          </FilterField>
          <FilterField label="Model">
            <Listbox
              value={filters.model ?? ""}
              options={modelOptions}
              onChange={(model) => patchFilters({ model })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Model"
              placeholder="All models"
              blankIsPlaceholder
            />
          </FilterField>
        </FilterSheet>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-3 show-scrollbar">
          {error ? (
            <EmptyState icon={AlertCircle} message={error} />
          ) : loading && items.length === 0 ? (
            <EmptyState
              icon={Loader2}
              message="Loading usage…"
              className="[&_svg]:animate-spin"
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Activity}
              message="No usage rows match these filters."
              detail={
                hasActiveFilters || draftQ.trim()
                  ? "Try clearing or widening your filters."
                  : "Start an agent run to track tokens."
              }
            />
          ) : (
            <div className="space-y-0.5">
              {items.map((row) => {
                const entries = buildBrowseDetailEntries(
                  {},
                  {
                    runId: row.runId,
                    threadId: row.threadId,
                    displayName: row.displayName,
                    status: row.status,
                    model: row.model,
                    goal: row.goal,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens,
                    totalTokens: row.totalTokens,
                    llmCalls: row.llmCalls,
                  },
                )
                const open = expanded === row.runId
                return (
                  <div key={row.runId}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-overlay-2"
                      onClick={() => setExpanded(open ? null : row.runId)}
                    >
                      {open ? (
                        <ChevronDown size={14} className="mt-0.5 shrink-0 text-text-muted" />
                      ) : (
                        <ChevronRight size={14} className="mt-0.5 shrink-0 text-text-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="shrink-0 font-mono text-[12px] text-text-muted">
                            {formatWhen(row.createdAt)}
                          </span>
                          <span className="shrink-0 font-mono text-[12px] text-text-faint">
                            {row.model}
                          </span>
                          {row.user && (
                            <span className="shrink-0 text-text-secondary">{row.user}</span>
                          )}
                          {row.status && (
                            <span className={`shrink-0 text-[12px] ${statusTone(row.status)}`}>
                              {row.status}
                            </span>
                          )}
                          <span className="ml-auto font-medium tabular-nums text-text">
                            {formatNumber(row.totalTokens)} tok
                          </span>
                          <span className="tabular-nums text-[12px] text-text-muted">
                            {row.llmCalls} calls
                          </span>
                        </div>
                        {(row.threadTitle || row.goal) && (
                          <div className="mt-1 truncate text-[12px] text-text-muted">
                            {row.threadTitle && (
                              <span className="mr-2 text-text-secondary">{row.threadTitle}</span>
                            )}
                            {row.goal && <span className="opacity-80">{row.goal}</span>}
                          </div>
                        )}
                      </div>
                    </button>
                    {open ? <AdminBrowseDetailPanel entries={entries} /> : null}
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

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border-subtle bg-overlay-2 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-muted">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums text-text">{value}</div>
      {hint ? <div className="text-[12px] text-text-faint">{hint}</div> : null}
    </div>
  )
}
