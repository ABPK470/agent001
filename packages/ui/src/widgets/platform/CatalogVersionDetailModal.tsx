/**
 * Structured detail + JSON snapshot diff for one sync catalog version.
 */

import { ChevronDown, ChevronRight, GitCompareArrows, History, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalShell } from "../entity-registry/ModalShell"
import { PANEL } from "../entity-registry/chrome"
import { CatalogJsonDiff } from "./CatalogJsonDiff"

type VersionDetail = Awaited<ReturnType<typeof api.getSyncCatalogVersion>>["detail"]
type VersionDiff = Awaited<ReturnType<typeof api.getSyncCatalogVersionDiff>>["diff"]
type DiffSection = VersionDiff["sections"][number]
type DiffEntry = DiffSection["creates"][number] | DiffSection["updates"][number] | DiffSection["deletes"][number]
type AgainstChoice = "previous" | "active"

const AGAINST_OPTIONS: ListboxOption<AgainstChoice>[] = [
  { value: "previous", label: "Previous version" },
  { value: "active", label: "Active version" },
]

export function CatalogVersionDetailModal({
  version,
  onClose,
}: {
  version: number
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [diff, setDiff] = useState<VersionDiff | null>(null)
  const [against, setAgainst] = useState<AgainstChoice>("previous")
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setErr(null)
    setOpenEntryKey(null)
    void (async () => {
      try {
        const [detailRes, diffRes] = await Promise.all([
          api.getSyncCatalogVersion(version),
          api.getSyncCatalogVersionDiff(version, against),
        ])
        if (cancelled) return
        setDetail(detailRes.detail)
        setDiff(diffRes.diff)
        const first = firstDiffEntryKey(diffRes.diff)
        setOpenEntryKey(first)
        setBusy(false)
      } catch (error) {
        if (cancelled) return
        setErr(error instanceof Error ? error.message : String(error))
        setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [version, against])

  const summary = detail?.summary
  const againstLabel =
    diff?.fromVersion != null
      ? `v${diff.fromVersion}`
      : against === "previous"
        ? "none (initial)"
        : "active"

  return (
    <ModalShell
      title={`Catalog version v${version}`}
      subtitle={detail?.isActive ? "Active snapshot" : "Historical snapshot"}
      icon={<History size={20} className="text-text-muted" />}
      onClose={onClose}
      size="focus"
      stackLevel={1}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4">
        {err && <p className="text-sm text-error">{err}</p>}
        {busy ? (
          <EmptyState icon={Loader2} message="Loading version…" className="[&_svg]:animate-spin" />
        ) : detail && summary ? (
          <>
            <section className={`${PANEL} space-y-2 p-4`}>
              <h3 className="text-sm font-medium text-text">Revision</h3>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Reason</dt>
                  <dd className="text-text">{detail.reason}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Created</dt>
                  <dd className="text-text">
                    {detail.createdBy} · {new Date(detail.createdAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Snapshot exported</dt>
                  <dd className="font-mono text-text">{new Date(summary.exportedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Tenant</dt>
                  <dd className="font-mono text-text">{summary.tenantId}</dd>
                </div>
              </dl>
            </section>

            <section className={`${PANEL} flex min-h-0 flex-col overflow-hidden`}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-text">
                    <GitCompareArrows size={14} className="text-text-muted" />
                    Changes
                  </h3>
                  <p className="text-xs text-text-muted">
                    JSON diff vs {againstLabel}
                    {diff ? ` · ${diff.changeCount} change${diff.changeCount === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <div className="w-44">
                  <Listbox
                    value={against}
                    options={AGAINST_OPTIONS}
                    onChange={setAgainst}
                    size="sm"
                    className="w-full listbox-control"
                    ariaLabel="Compare against"
                  />
                </div>
              </div>

              {!diff || diff.sections.length === 0 ? (
                <p className="px-4 py-6 text-sm text-text-muted">
                  {diff?.fromVersion == null && against === "previous"
                    ? "Initial catalog version — nothing to compare against."
                    : "No differences in this comparison."}
                </p>
              ) : (
                <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto show-scrollbar p-4">
                  {diff.sections.map((section) => (
                    <li key={section.section} className="rounded-lg border border-border-subtle p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h4 className="text-sm font-medium text-text">{section.label}</h4>
                        <span className="font-mono text-xs text-text-faint">
                          +{section.creates.length} ~{section.updates.length} −{section.deletes.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {[...section.creates, ...section.updates, ...section.deletes].map((entry) => {
                          const key = `${section.section}:${entry.kind}:${entry.id}`
                          const open = openEntryKey === key
                          return (
                            <DiffEntryCard
                              key={key}
                              entry={entry}
                              open={open}
                              onToggle={() => setOpenEntryKey(open ? null : key)}
                            />
                          )
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={`${PANEL} p-4`}>
              <h3 className="mb-3 text-sm font-medium text-text">Contents</h3>
              <div className="grid grid-cols-7 gap-2">
                <Stat label="Entities" value={summary.entityCount} />
                <Stat label="Run configs" value={summary.configCount} />
                <Stat label="Flows" value={summary.flowCount} />
                <Stat label="Step types" value={summary.stepTypeCount} />
                <Stat label="Value sources" value={summary.customValueSourceCount} />
                <Stat label="Strategies" value={summary.strategyCount} />
                <Stat label="Environments" value={summary.environmentCount} />
              </div>
            </section>
          </>
        ) : null}
      </div>
    </ModalShell>
  )
}

function DiffEntryCard({
  entry,
  open,
  onToggle,
}: {
  entry: DiffEntry
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const tone =
    entry.kind === "create"
      ? "text-emerald-300"
      : entry.kind === "delete"
        ? "text-rose-300"
        : "text-amber-300"
  const label =
    entry.kind === "create" ? "Added" : entry.kind === "delete" ? "Removed" : "Changed"

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle/80">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-elevated/40"
      >
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-text-faint" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-text-faint" />
        )}
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${tone}`}>{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{entry.id}</span>
        {entry.changedPaths.length > 0 && (
          <span className="hidden max-w-[40%] truncate text-xs text-text-faint sm:inline">
            {entry.changedPaths.slice(0, 4).join(", ")}
            {entry.changedPaths.length > 4 ? ` +${entry.changedPaths.length - 4}` : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border-subtle p-2">
          <CatalogJsonDiff beforeJson={entry.beforeJson} afterJson={entry.afterJson} />
        </div>
      )}
    </div>
  )
}

function firstDiffEntryKey(diff: VersionDiff): string | null {
  for (const section of diff.sections) {
    const entry = section.creates[0] ?? section.updates[0] ?? section.deletes[0]
    if (entry) return `${section.section}:${entry.kind}:${entry.id}`
  }
  return null
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border-subtle bg-elevated/30 px-2 py-2 text-center">
      <div className="font-mono text-base font-semibold tabular-nums text-text sm:text-lg">{value}</div>
      <div className="truncate text-[11px] leading-tight text-text-muted">{label}</div>
    </div>
  )
}
