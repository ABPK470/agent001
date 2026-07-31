/**
 * CatalogVersionsModal — browse sync catalog versions and rollback via import gate.
 */

import { History, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react"
import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../client/index"
import { DateField } from "../../components/DateField"
import { EmptyState } from "../../components/EmptyState"
import {
  ActiveFilterChips,
  FilterField,
  FilterSheet,
  FilterToggles,
  type ActiveFilterChipModel,
} from "../../components/FilterSheet"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalSearchField } from "../../components/ModalSearchField"
import { useLiveReload } from "../../hooks/useLiveReload"
import { ModalShell } from "../entity-registry/ModalShell"
import { activePublishBadge } from "./catalog-publish-badge"
import { CatalogRollbackGate } from "./CatalogRollbackGate"
import { CatalogVersionDetailModal } from "./CatalogVersionDetailModal"
import {
  CATALOG_VERSION_KIND_OPTIONS,
  CATALOG_VERSION_SORT_OPTIONS,
  countActiveCatalogVersionFilters,
  DEFAULT_CATALOG_VERSION_FILTERS,
  filterCatalogVersions,
  type CatalogVersionFilters,
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
  const [operationalCatalogAhead, setOperationalCatalogAhead] = useState(false)
  const [publishedCatalogVersion, setPublishedCatalogVersion] = useState<number | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const [res, health, status] = await Promise.all([
        api.listSyncCatalogVersions(),
        api.getPlatformHealth().catch((err: unknown) => { console.error("[mia]", err) }),
        api.getSyncPublishStatus().catch((err: unknown) => { console.error("[mia]", err) }),
      ])
      setActiveVersion(res.activeVersion)
      setVersions(res.versions)
      setBundlePublishedAt(status?.publishedAt ?? health?.publish?.publishedAt ?? null)
      setActiveNeedsPublish(Boolean(status?.catalogNeedsPublish || (status?.unpublishedEntityCount ?? 0) > 0))
      setOperationalCatalogAhead(Boolean(status?.operationalCatalogAhead))
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

  const actorOptions = useMemo<ListboxOption<string>[]>(() => {
    const actors = [...new Set(versions.map((entry) => entry.createdBy).filter(Boolean))].sort()
    return [
      { value: "", label: "Any" },
      ...actors.map((actor) =>
        actor === "system"
          ? { value: actor, label: "system", hint: "Platform / seed — not a registered user" }
          : { value: actor, label: actor },
      ),
    ]
  }, [versions])

  function clearFilters(): void {
    setSearchDraft("")
    setFilters(DEFAULT_CATALOG_VERSION_FILTERS)
  }

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    for (const kind of filters.kinds ?? []) {
      const label =
        CATALOG_VERSION_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
      chips.push({
        id: `kind:${kind}`,
        label: "Kind",
        value: label,
        onRemove: () => {
          setFilters((current) => {
            const next = (current.kinds ?? []).filter((item) => item !== kind)
            return { ...current, kinds: next.length > 0 ? next : undefined }
          })
        },
      })
    }
    if (filters.from?.trim()) {
      chips.push({
        id: "from",
        label: "From",
        value: filters.from,
        onRemove: () => setFilters((current) => ({ ...current, from: undefined })),
      })
    }
    if (filters.to?.trim()) {
      chips.push({
        id: "to",
        label: "To",
        value: filters.to,
        onRemove: () => setFilters((current) => ({ ...current, to: undefined })),
      })
    }
    if (filters.actor?.trim()) {
      chips.push({
        id: "user",
        label: "User",
        value: filters.actor,
        onRemove: () => setFilters((current) => ({ ...current, actor: undefined })),
      })
    }
    return chips
  }, [filters])

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
          {/*
           * Modal browse strip — same dialect as Audit / Usage (px-6).
           * Do not use WidgetToolbar here: that strip assumes a widget shell
           * owns horizontal inset, so padding utilities fight its CSS and the
           * search row drifts off the list column.
           */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-6 py-3">
            <div className="min-w-0 flex-1">
              <ModalSearchField
                value={searchDraft}
                onChange={setSearchDraft}
                placeholder="Search versions…"
                aria-label="Search versions"
              />
            </div>
            <div className="w-[7.5rem] shrink-0">
              <Listbox
                value={filters.sort}
                options={CATALOG_VERSION_SORT_OPTIONS as ListboxOption<CatalogVersionSort>[]}
                onChange={(sort) => setFilters((current) => ({ ...current, sort }))}
                size="sm"
                className="w-full listbox-control"
                ariaLabel="Sort"
              />
            </div>
            <span
              className="hidden shrink-0 tabular-nums text-xs text-text-muted sm:inline"
              aria-label={`${filtered.length} of ${versions.length} shown`}
            >
              {filtered.length}/{versions.length}
            </span>
            <button
              ref={filterBtnRef}
              type="button"
              onClick={() => setFiltersOpen((value) => !value)}
              className={`mia-control relative flex h-9 w-9 items-center justify-center ${
                filtersOpen || activeFilterCount > 0 ? "border-border-strong text-text" : ""
              }`}
              title={
                activeFilterCount > 0
                  ? `Filters (${activeFilterCount} active)`
                  : "Filters"
              }
              aria-pressed={filtersOpen || activeFilterCount > 0}
            >
              <SlidersHorizontal size={15} />
              {activeFilterCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-text px-0.5 text-[9px] font-mono font-medium leading-none text-text-on-accent">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>

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
                  className="text-xs font-medium text-text-muted hover:text-text"
                >
                  Clear all
                </button>
              ) : null
            }
          >
            <FilterField label="Kind">
              <FilterToggles
                options={CATALOG_VERSION_KIND_OPTIONS}
                values={filters.kinds ?? []}
                onChange={(kinds) =>
                  setFilters((current) => ({
                    ...current,
                    kinds: kinds.length > 0 ? kinds : undefined,
                  }))
                }
              />
            </FilterField>
            <div className="grid grid-cols-2 gap-3">
              <FilterField label="From">
                <DateField
                  value={filters.from}
                  onChange={(from) => setFilters((current) => ({ ...current, from }))}
                  placeholder="Pick date"
                  ariaLabel="From"
                  size="sm"
                  className="w-full"
                />
              </FilterField>
              <FilterField label="To">
                <DateField
                  value={filters.to}
                  onChange={(to) => setFilters((current) => ({ ...current, to }))}
                  placeholder="Pick date"
                  ariaLabel="To"
                  size="sm"
                  className="w-full"
                />
              </FilterField>
            </div>
            <FilterField label="User">
              <Listbox
                value={filters.actor ?? ""}
                options={actorOptions}
                onChange={(actor) =>
                  setFilters((current) => ({ ...current, actor: actor || undefined }))
                }
                size="sm"
                className="w-full listbox-control"
                ariaLabel="User"
                placeholder="UPN"
                blankIsPlaceholder
              />
            </FilterField>
          </FilterSheet>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 pb-4 pt-3">
            {err && <p className="text-sm text-error">{err}</p>}
            <p className="shrink-0 text-xs text-text-faint">
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
                    className={`flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors ${
                      entry.isActive ? "bg-[var(--select-fill)]" : "hover:bg-[var(--hover-fill)]"
                    }`}
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
                          <ActivePublishBadge
                            version={entry.version}
                            publishedCatalogVersion={publishedCatalogVersion}
                            needsPublish={activeNeedsPublish}
                            operationalAhead={operationalCatalogAhead}
                          />
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
            void load().catch((err: unknown) => { console.error("[mia]", err) })
            onRolledBack()
          }}
        />
      )}
    </>
  )
}

function ActivePublishBadge({
  version,
  publishedCatalogVersion,
  needsPublish,
  operationalAhead,
}: {
  version: number
  publishedCatalogVersion: number | null
  needsPublish: boolean
  operationalAhead: boolean
}): JSX.Element {
  const badge = activePublishBadge({
    version,
    publishedCatalogVersion,
    needsPublish,
    operationalAhead,
  })
  const toneClass =
    badge.tone === "success"
      ? "border-success/30 bg-success/10 text-success"
      : badge.tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-accent/30 bg-accent/10 text-accent"
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${toneClass}`}
      title={badge.title}
    >
      {badge.label}
    </span>
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
