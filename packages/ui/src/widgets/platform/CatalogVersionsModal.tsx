/**
 * CatalogVersionsModal — browse sync catalog versions and rollback via import gate.
 */

import { History, Loader2, RotateCcw, SlidersHorizontal, X } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../client/index"
import { DateField } from "../../components/DateField"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { SearchablePick, type SearchablePickOption } from "../../components/SearchablePick"
import { useLiveReload } from "../../hooks/useLiveReload"
import { TAB_PILL, TAB_PILL_ACTIVE, TAB_PILL_IDLE } from "../entity-registry/chrome"
import { ModalShell } from "../entity-registry/ModalShell"
import {
  WidgetToolbar,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import { CatalogRollbackGate } from "./CatalogRollbackGate"
import { CatalogVersionDetailModal } from "./CatalogVersionDetailModal"
import {
  CATALOG_VERSION_KIND_OPTIONS,
  CATALOG_VERSION_SORT_OPTIONS,
  countActiveCatalogVersionFilters,
  DEFAULT_CATALOG_VERSION_FILTERS,
  filterCatalogVersions,
  type CatalogVersionFilters,
  type CatalogVersionKind,
  type CatalogVersionSort,
} from "./catalog-version-filters"

const SEARCH_DEBOUNCE_MS = 300

export function CatalogVersionsModal({
  onClose,
  onRolledBack,
}: {
  onClose: () => void
  onRolledBack: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof api.listSyncCatalogVersions>>["versions"]>([])
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null)
  const [detailVersion, setDetailVersion] = useState<number | null>(null)
  const [filters, setFilters] = useState<CatalogVersionFilters>(DEFAULT_CATALOG_VERSION_FILTERS)
  const [searchDraft, setSearchDraft] = useState("")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [bundlePublishedAt, setBundlePublishedAt] = useState<string | null>(null)
  const [activeNeedsPublish, setActiveNeedsPublish] = useState(false)
  const [publishedCatalogVersion, setPublishedCatalogVersion] = useState<number | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const [res, health, status] = await Promise.all([
        api.listSyncCatalogVersions(),
        api.getPlatformHealth().catch(() => null),
        api.getSyncPublishStatus().catch(() => null),
      ])
      setActiveVersion(res.activeVersion)
      setVersions(res.versions)
      setBundlePublishedAt(status?.publishedAt ?? health?.publish?.publishedAt ?? null)
      setActiveNeedsPublish(Boolean(status?.catalogNeedsPublish || (status?.unpublishedEntityCount ?? 0) > 0))
      setPublishedCatalogVersion(status?.publishedCatalogVersion ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useLiveReload(load, isCatalogVersionsReloadEvent)

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

  const activeFilterCount = useMemo(
    () => countActiveCatalogVersionFilters(filters, searchDraft),
    [filters, searchDraft],
  )
  const hasActiveFilters = activeFilterCount > 0

  const filtered = useMemo(
    () => filterCatalogVersions(versions, filters),
    [versions, filters],
  )

  const actorOptions = useMemo<SearchablePickOption[]>(() => {
    const actors = [...new Set(versions.map((entry) => entry.createdBy).filter(Boolean))].sort()
    return [
      { value: "", label: "Any user" },
      ...actors.map((actor) => ({ value: actor, label: actor })),
    ]
  }, [versions])

  function clearFilters(): void {
    setSearchDraft("")
    setFilters(DEFAULT_CATALOG_VERSION_FILTERS)
  }

  function toggleKind(kind: CatalogVersionKind): void {
    setFilters((current) => {
      const selected = new Set(current.kinds ?? [])
      if (selected.has(kind)) selected.delete(kind)
      else selected.add(kind)
      const next = [...selected]
      return { ...current, kinds: next.length > 0 ? next : undefined }
    })
  }

  return (
    <>
      <ModalShell
        title="Configuration versions"
        subtitle="Full sync catalog snapshots. Export always reflects the active version. Rollback applies a prior snapshot as a new version. Publish is separate — it compiles the active catalog into the sync runtime bundle."
        icon={<History size={20} className="text-text-muted" />}
        onClose={onClose}
        size="focus"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <WidgetToolbar className="shrink-0 border-b border-border/40 !rounded-none !border-x-0 !border-t-0 !bg-transparent px-3 py-1.5">
            <WidgetToolbarSearch
              value={searchDraft}
              onChange={setSearchDraft}
              placeholder="Search versions…"
              onClear={() => setSearchDraft("")}
            />
            <WidgetToolbarTrailing>
              <span className="widget-toolbar__count hidden sm:inline-flex">
                <span className="widget-toolbar__count-filtered">{filtered.length}</span>
                <span className="widget-toolbar__count-sep">/</span>
                <span className="widget-toolbar__count-total">{versions.length}</span>
              </span>
              <button
                type="button"
                onClick={() => setFiltersOpen((value) => !value)}
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

          {filtersOpen && (
            <div className="shrink-0 border-b border-border/40 bg-base/20 px-3 py-2 space-y-2.5">
              <div className="space-y-1.5">
                <div className="field-label">Change kind</div>
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Change kind">
                  {CATALOG_VERSION_KIND_OPTIONS.map((option) => {
                    const active = (filters.kinds ?? []).includes(option.value)
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleKind(option.value)}
                        className={[TAB_PILL, active ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <FilterField label="From">
                  <DateField
                    value={filters.from}
                    onChange={(from) => setFilters((current) => ({ ...current, from }))}
                    placeholder="Any start date"
                    ariaLabel="Filter from date"
                    size="sm"
                    className="w-full"
                  />
                </FilterField>
                <FilterField label="To">
                  <DateField
                    value={filters.to}
                    onChange={(to) => setFilters((current) => ({ ...current, to }))}
                    placeholder="Any end date"
                    ariaLabel="Filter to date"
                    size="sm"
                    className="w-full"
                  />
                </FilterField>
                <FilterField label="Sort">
                  <Listbox
                    value={filters.sort}
                    options={CATALOG_VERSION_SORT_OPTIONS as ListboxOption<CatalogVersionSort>[]}
                    onChange={(sort) => setFilters((current) => ({ ...current, sort }))}
                    size="sm"
                    className="w-full listbox-control"
                    ariaLabel="Sort order"
                  />
                </FilterField>
                <FilterField label="User">
                  <SearchablePick
                    value={filters.actor ?? ""}
                    options={actorOptions}
                    onChange={(actor) =>
                      setFilters((current) => ({ ...current, actor: actor || undefined }))
                    }
                    placeholder="Any user"
                    ariaLabel="Filter by user"
                    className="listbox-control"
                  />
                </FilterField>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-pressed={filters.activeOnly}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      activeOnly: !current.activeOnly,
                    }))
                  }
                  className={[TAB_PILL, filters.activeOnly ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
                >
                  Active only
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 rounded-lg border border-border/50 px-3 py-1.5 text-xs text-text-muted hover:text-text hover:bg-elevated/30 transition-colors"
                  >
                    <X size={12} />
                    Clear all
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4 pt-3">
            {err && <p className="text-sm text-error">{err}</p>}
            <p className="text-xs text-text-faint">
              Sync bundle last published:{" "}
              {bundlePublishedAt ? new Date(bundlePublishedAt).toLocaleString() : "never"}
              {publishedCatalogVersion != null ? ` (from catalog v${publishedCatalogVersion})` : ""}
              {activeVersion != null ? ` · Active catalog: v${activeVersion}` : ""}
            </p>
            {busy ? (
              <EmptyState icon={Loader2} message="Loading…" className="[&_svg]:animate-spin" />
            ) : versions.length === 0 ? (
              <EmptyState icon={History} message="No versions recorded yet." />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={History}
                message="No versions match your filters"
                action={
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-xs text-accent hover:text-accent/80 transition-colors"
                  >
                    Clear filters
                  </button>
                }
              />
            ) : (
              <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto show-scrollbar">
                {filtered.map((entry) => (
                  <li
                    key={entry.version}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${entry.isActive ? "border-accent/40 bg-accent/5" : "border-border-subtle"}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setDetailVersion(entry.version)}
                    >
                      <div className="flex flex-wrap items-center gap-2 font-mono font-medium text-text">
                        <span>v{entry.version}</span>
                        {entry.isActive && (
                          <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                            active
                          </span>
                        )}
                        {entry.isActive && (
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                              activeNeedsPublish
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                : "border-success/30 bg-success/10 text-success"
                            }`}
                            title={
                              activeNeedsPublish
                                ? publishedCatalogVersion != null
                                  ? `Active catalog v${activeVersion} is ahead of last publish (from v${publishedCatalogVersion})`
                                  : "Active catalog has changes not yet compiled into the sync publish bundle"
                                : "Active catalog matches the published sync bundle"
                            }
                          >
                            {activeNeedsPublish ? "publish pending" : "published"}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-text-muted">{entry.reason}</div>
                      <div className="text-xs text-text-faint">
                        {entry.createdBy} · {new Date(entry.createdAt).toLocaleString()}
                      </div>
                    </button>
                    {!entry.isActive && (
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1 text-xs hover:bg-elevated/40"
                        disabled={restoreVersion !== null}
                        onClick={() => setRestoreVersion(entry.version)}
                      >
                        <RotateCcw className="inline h-3 w-3" /> Restore
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ModalShell>

      {detailVersion !== null && (
        <CatalogVersionDetailModal
          version={detailVersion}
          onClose={() => setDetailVersion(null)}
        />
      )}

      {restoreVersion !== null && (
        <CatalogRollbackGate
          version={restoreVersion}
          onClose={() => setRestoreVersion(null)}
          onRestored={() => {
            setRestoreVersion(null)
            void load()
            onRolledBack()
          }}
        />
      )}
    </>
  )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

/** Catalog versions advance when registry/env/metadata mutate — same SSE family as registry shell. */
function isCatalogVersionsReloadEvent(type: string): boolean {
  return (
    type.startsWith("entity_registry.") ||
    type.startsWith("sync_env.") ||
    type.startsWith("sync.metadata.") ||
    type === "sync.catalog.version.committed" ||
    type === "sync.definitions.published"
  )
}
