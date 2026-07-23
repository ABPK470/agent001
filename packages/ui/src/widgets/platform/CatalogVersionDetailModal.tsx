/**
 * Structured detail + JSON snapshot diff for one sync catalog version.
 */

import { GitCompareArrows, History, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { ModalShell } from "../entity-registry/ModalShell"
import { PANEL } from "../entity-registry/chrome"
import {
  CatalogDiffSections,
  firstCatalogDiffEntryKey,
  type CatalogDiffSection,
} from "./CatalogDiffSections"

type VersionDetail = Awaited<ReturnType<typeof api.getSyncCatalogVersion>>["detail"]
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
  const [sections, setSections] = useState<CatalogDiffSection[]>([])
  const [fromVersion, setFromVersion] = useState<number | null>(null)
  const [changeCount, setChangeCount] = useState(0)
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
        setSections(diffRes.diff.sections)
        setFromVersion(diffRes.diff.fromVersion)
        setChangeCount(diffRes.diff.changeCount)
        setOpenEntryKey(firstCatalogDiffEntryKey(diffRes.diff.sections))
        setBusy(false)
      } catch (error) {
        if (cancelled) return
        setErr(error instanceof Error ? error.message : String(error))
        setBusy(false)
      }
    })().catch((err: unknown) => { console.error("[mia]", err) })
    return () => {
      cancelled = true
    }
  }, [version, against])

  const summary = detail?.summary
  const againstLabel =
    fromVersion != null
      ? `v${fromVersion}`
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
        {err && <p className="shrink-0 text-sm text-error">{err}</p>}
        {busy ? (
          <EmptyState icon={Loader2} message="Loading version…" className="[&_svg]:animate-spin" />
        ) : detail && summary ? (
          <>
            <section className={`${PANEL} shrink-0 space-y-2 p-4`}>
              <h3 className="text-sm font-medium text-text">Revision</h3>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Reason</dt>
                  <dd className="break-words text-text">{detail.reason}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Created</dt>
                  <dd className="text-text">
                    {detail.createdBy} · {new Date(detail.createdAt).toLocaleString()}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Snapshot exported</dt>
                  <dd className="font-mono text-text">{new Date(summary.exportedAt).toLocaleString()}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs uppercase tracking-wider text-text-muted">Tenant</dt>
                  <dd className="font-mono text-text">{summary.tenantId}</dd>
                </div>
              </dl>
            </section>

            <section className={`${PANEL} flex min-h-0 flex-1 flex-col overflow-hidden`}>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-text">
                    <GitCompareArrows size={14} className="text-text-muted" />
                    Changes
                  </h3>
                  <p className="text-xs text-text-muted">
                    JSON diff vs {againstLabel}
                    {changeCount > 0 ? ` · ${changeCount} change${changeCount === 1 ? "" : "s"}` : ""}
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

              <CatalogDiffSections
                sections={sections}
                openEntryKey={openEntryKey}
                onToggleEntry={setOpenEntryKey}
                changesOnly
                emptyMessage={
                  fromVersion == null && against === "previous"
                    ? "Initial catalog version — nothing to compare against."
                    : "No differences in this comparison."
                }
              />
            </section>

            <section className={`${PANEL} shrink-0 p-4`}>
              <h3 className="mb-3 text-sm font-medium text-text">Contents</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="Entities" value={summary.entityCount} />
                <Stat label="Run configs" value={summary.configCount} />
                <Stat label="Flows" value={summary.flowCount} />
                <Stat label="Actions" value={summary.stepTypeCount} />
                <Stat label="Sources" value={summary.customValueSourceCount} />
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

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border-subtle bg-elevated/30 px-2 py-2 text-center">
      <div className="font-mono text-base font-semibold tabular-nums text-text sm:text-lg">{value}</div>
      <div className="truncate text-[11px] leading-tight text-text-muted">{label}</div>
    </div>
  )
}
