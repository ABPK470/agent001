/**
 * AuditModal — admin platform-wide audit browser.
 *
 * Fixed CSS-grid table + right transform inspector (no accordion).
 * Filters: BrowseStrip → ActiveFilterChips → FilterSheet (Usage dialect).
 */

import {
  AlertCircle,
  Download,
  Loader2,
  Scale,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  api,
  type AdminAuditFilterOptions,
  type AdminAuditItem,
  type AdminAuditParams,
  type AdminAuditSort,
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
import { AuditInspector } from "./AuditInspector"
import {
  actionVerbClass,
  actionVerbKind,
  auditSummary,
  auditTarget,
  formatAuditScope,
  formatAuditWhen,
} from "./audit-log-view"

const PAGE_SIZE = 50
const AUDIT_INSPECTOR_W_DEFAULT = 400
const AUDIT_INSPECTOR_W_WIDE = 640
const AUDIT_INSPECTOR_W_MIN = 360
const AUDIT_INSPECTOR_W_MAX = 700

const SCOPE_OPTIONS: ListboxOption<string>[] = [
  { value: "", label: "All scopes" },
  { value: "run", label: "Agent runs" },
  { value: "admin", label: "Admin / platform" },
]

const SORT_OPTIONS: ListboxOption<AdminAuditSort>[] = [
  { value: "timestamp_desc", label: "Newest" },
  { value: "timestamp_asc", label: "Oldest" },
]

const EMPTY_FILTERS: Omit<AdminAuditParams, "page" | "pageSize" | "q"> = {
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return target.isContentEditable
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
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(AUDIT_INSPECTOR_W_DEFAULT)
  const [inspectorWide, setInspectorWide] = useState(false)
  const [inspectorResizing, setInspectorResizing] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [options, setOptions] = useState<AdminAuditFilterOptions>({
    users: [],
    scopeIds: [],
    actions: [],
  })
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const openInspectorRafRef = useRef(0)
  const inspectorOpenRef = useRef(inspectorOpen)
  inspectorOpenRef.current = inspectorOpen
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const itemsRef = useRef(items)
  itemsRef.current = items

  const selectedEntry = useMemo(
    () => items.find((e) => e.id === selectedId) ?? null,
    [items, selectedId],
  )

  useEffect(() => {
    api.adminAuditOptions().then(setOptions).catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  useEffect(() => () => cancelAnimationFrame(openInspectorRafRef.current), [])

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
      setSelectedId((prev) => {
        if (prev == null) return null
        return data.items.some((e) => e.id === prev) ? prev : null
      })
      if (!data.items.some((e) => e.id === selectedIdRef.current)) {
        setInspectorOpen(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log")
      setItems([])
      setTotal(0)
      setTotalPages(1)
      setSelectedId(null)
      setInspectorOpen(false)
    } finally {
      setLoading(false)
    }
  }, [queryParams])

  useEffect(() => {
    void load().catch((err: unknown) => { console.error("[mia]", err) })
  }, [load])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filters.scopeType) n++
    if (filters.scopeId) n++
    if (filters.user) n++
    if (filters.action) n++
    if (filters.runId) n++
    if (filters.threadId) n++
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

  function openInspector(id: number) {
    setSelectedId(id)
    if (inspectorOpenRef.current) return
    cancelAnimationFrame(openInspectorRafRef.current)
    // Mount closed for one paint, then open — so transform transition can run.
    openInspectorRafRef.current = requestAnimationFrame(() => {
      openInspectorRafRef.current = requestAnimationFrame(() => {
        setInspectorOpen(true)
      })
    })
  }

  function closeInspector() {
    setInspectorOpen(false)
  }

  function onInspectorExited() {
    if (inspectorOpenRef.current) return
    setSelectedId(null)
  }

  function clampInspectorWidth(px: number): number {
    return Math.min(AUDIT_INSPECTOR_W_MAX, Math.max(AUDIT_INSPECTOR_W_MIN, Math.round(px)))
  }

  function onInspectorWidthChange(px: number) {
    const next = clampInspectorWidth(px)
    setInspectorWidth(next)
    setInspectorWide(next >= AUDIT_INSPECTOR_W_WIDE - 8)
  }

  function toggleInspectorWide() {
    if (inspectorWide) {
      setInspectorWide(false)
      setInspectorWidth(AUDIT_INSPECTOR_W_DEFAULT)
      return
    }
    setInspectorWide(true)
    setInspectorWidth(AUDIT_INSPECTOR_W_WIDE)
  }

  function stepSelection(delta: number) {
    const list = itemsRef.current
    if (list.length === 0) return
    const cur = selectedIdRef.current
    const idx = cur == null ? -1 : list.findIndex((e) => e.id === cur)
    const from = idx >= 0 ? idx : 0
    const next = list[(from + delta + list.length) % list.length]
    if (!next) return
    openInspector(next.id)
  }

  function scrollSelectedRowIntoView(id: number) {
    const root = tableScrollRef.current
    if (!root) return
    const row = root.querySelector(`[data-audit-id="${id}"]`)
    if (!(row instanceof HTMLElement)) return
    row.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  // Keep keyboard (and wrap-around) selection visible in the scrollport.
  useEffect(() => {
    if (selectedId == null) return
    scrollSelectedRowIntoView(selectedId)
  }, [selectedId])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return
      if (filtersOpen) return
      if (!selectedIdRef.current && !inspectorOpenRef.current) return
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        stepSelection(1)
        return
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        stepSelection(-1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [filtersOpen])

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
        label: "Actor",
        value: filters.user,
        onRemove: () => patchFilters({ user: "" }),
      })
    }
    if (filters.scopeType?.trim()) {
      chips.push({
        id: "scopeType",
        label: "Scope",
        value: filters.scopeType === "run" ? "Agent runs" : "Admin / platform",
        onRemove: () => patchFilters({ scopeType: "" }),
      })
    }
    if (filters.scopeId?.trim()) {
      chips.push({
        id: "scopeId",
        label: "Scope id",
        value: filters.scopeId,
        onRemove: () => patchFilters({ scopeId: "" }),
      })
    }
    if (filters.action?.trim()) {
      chips.push({
        id: "action",
        label: "Action",
        value: filters.action,
        onRemove: () => patchFilters({ action: "" }),
      })
    }
    if (filters.runId?.trim()) {
      chips.push({
        id: "runId",
        label: "Run",
        value: filters.runId,
        onRemove: () => patchFilters({ runId: "" }),
      })
    }
    if (filters.threadId?.trim()) {
      chips.push({
        id: "threadId",
        label: "Thread",
        value: filters.threadId,
        onRemove: () => patchFilters({ threadId: "" }),
      })
    }
    return chips
  }, [filters])

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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AdminBrowseToolbar
          search={draftQ}
          onSearchChange={onSearchChange}
          searchPlaceholder="Search action, actor, detail, run, goal…"
          searchAriaLabel="Search audit log"
          filtersOpen={filtersOpen}
          onToggleFilters={() => setFiltersOpen((v) => !v)}
          activeFilterCount={activeFilterCount}
          onRefresh={() => void load().catch((err: unknown) => { console.error("[mia]", err) })}
          loading={loading}
          filterBtnRef={filterBtnRef}
          trailing={
            <>
              <div className="w-[7.75rem] shrink-0">
                <Listbox
                  value={filters.sort ?? "timestamp_desc"}
                  options={SORT_OPTIONS}
                  onChange={(sort) => patchFilters({ sort })}
                  size="sm"
                  className="w-full listbox-control"
                  ariaLabel="Sort"
                />
              </div>
              <button
                type="button"
                disabled={exporting || total === 0}
                onClick={() => void handleExport("csv").catch((err: unknown) => { console.error("[mia]", err) })}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[13px] text-text-secondary transition-colors hover:bg-overlay-hover hover:text-text disabled:opacity-30"
                title="Export filtered results as CSV"
              >
                <Download size={14} />
                CSV
              </button>
              <button
                type="button"
                disabled={exporting || total === 0}
                onClick={() => void handleExport("json").catch((err: unknown) => { console.error("[mia]", err) })}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-border-subtle px-3 text-[13px] text-text-secondary transition-colors hover:bg-overlay-hover hover:text-text disabled:opacity-30"
                title="Export filtered results as JSON"
              >
                <Download size={14} />
                JSON
              </button>
            </>
          }
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
          <FilterField label="Actor">
            <Listbox
              value={filters.user ?? ""}
              options={userOptions}
              onChange={(user) => patchFilters({ user })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Actor"
              placeholder="All users"
              blankIsPlaceholder
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
              ariaLabel="Scope type"
              blankIsPlaceholder
            />
          </FilterField>
          <FilterField label="Scope id">
            <Listbox
              value={filters.scopeId ?? ""}
              options={scopeIdOptions}
              onChange={(scopeId) => patchFilters({ scopeId })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Scope id"
              placeholder="Any scope id"
              blankIsPlaceholder
            />
          </FilterField>
          <FilterField label="Action">
            <Listbox
              value={filters.action ?? ""}
              options={actionOptions}
              onChange={(action) => patchFilters({ action })}
              size="sm"
              className="w-full listbox-control"
              ariaLabel="Action"
              placeholder="Any action"
              blankIsPlaceholder
            />
          </FilterField>
          <div className="grid grid-cols-2 gap-3">
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
        </FilterSheet>

        <div
          className="audit-log-host min-w-0"
          data-inspector-open={inspectorOpen ? "true" : "false"}
          data-resizing={inspectorResizing ? "true" : "false"}
          style={{ ["--audit-inspector-w" as string]: `${inspectorWidth}px` }}
        >
          {error ? (
            <EmptyState icon={AlertCircle} message={error} />
          ) : loading && items.length === 0 ? (
            <EmptyState icon={Loader2} message="Loading audit log…" className="[&_svg]:animate-spin" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Scale}
              message="No audit entries match these filters."
              detail={
                hasActiveFilters || draftQ.trim()
                  ? "Try clearing or widening your filters."
                  : undefined
              }
            />
          ) : (
            <>
              <div ref={tableScrollRef} className="audit-log-host__table show-scrollbar">
                <div className="audit-log-table" role="table" aria-label="Audit log">
                  <div className="audit-log-table__head" role="row">
                    <span role="columnheader">Timestamp</span>
                    <span role="columnheader">Actor</span>
                    <span className="audit-log-table__col--scope" role="columnheader">Scope</span>
                    <span role="columnheader">Action</span>
                    <span role="columnheader">Target</span>
                    <span role="columnheader">Summary</span>
                  </div>
                  {items.map((entry) => {
                    const summary = auditSummary(entry)
                    const target = auditTarget(entry)
                    const when = formatAuditWhen(entry.timestamp)
                    const scope = formatAuditScope(entry)
                    const actor = entry.user ?? "—"
                    const verb = actionVerbKind(entry.action)
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        role="row"
                        className="audit-log-table__row"
                        data-audit-id={entry.id}
                        data-selected={selectedId === entry.id ? "true" : "false"}
                        onClick={() => openInspector(entry.id)}
                      >
                        <span
                          className="audit-log-table__cell font-mono text-[12px] text-text-muted"
                          role="cell"
                          title={when}
                        >
                          {when}
                        </span>
                        <span
                          className="audit-log-table__cell text-text-secondary"
                          role="cell"
                          title={actor}
                        >
                          {actor}
                        </span>
                        <span className="audit-log-table__cell audit-log-table__col--scope" role="cell">
                          <span className="audit-log-table__scope" title={scope}>
                            {scope}
                          </span>
                        </span>
                        <span
                          className={`audit-log-table__cell audit-log-table__cell--action font-mono text-[12px] font-medium ${actionVerbClass(verb)}`}
                          role="cell"
                          title={entry.action}
                        >
                          {entry.action}
                        </span>
                        <span
                          className="audit-log-table__cell audit-log-table__cell--target font-mono text-[12px] text-text-secondary"
                          role="cell"
                          title={target}
                        >
                          {target}
                        </span>
                        <span
                          className="audit-log-table__cell audit-log-table__cell--summary text-text-muted"
                          role="cell"
                          title={summary}
                        >
                          {summary}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
              {selectedEntry ? (
                <AuditInspector
                  entry={selectedEntry}
                  open={inspectorOpen}
                  wide={inspectorWide}
                  widthPx={inspectorWidth}
                  onWidthChange={onInspectorWidthChange}
                  onToggleWide={toggleInspectorWide}
                  onResizingChange={setInspectorResizing}
                  onClose={closeInspector}
                  onExited={onInspectorExited}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
