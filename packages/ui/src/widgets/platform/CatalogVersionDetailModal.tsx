/**
 * Structured detail for one sync catalog version snapshot.
 */

import { History, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { ModalShell } from "../entity-registry/ModalShell"
import { PANEL } from "../entity-registry/chrome"

type VersionDetail = Awaited<ReturnType<typeof api.getSyncCatalogVersion>>["detail"]

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

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setErr(null)
    void (async () => {
      try {
        const res = await api.getSyncCatalogVersion(version)
        if (cancelled) return
        setDetail(res.detail)
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
  }, [version])

  const summary = detail?.summary

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

            <section className={`${PANEL} p-4`}>
              <h3 className="mb-3 text-sm font-medium text-text">Contents</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Entities" value={summary.entityCount} />
                <Stat label="Run configs" value={summary.configCount} />
                <Stat label="Flows" value={summary.flowCount} />
                <Stat label="Step types" value={summary.stepTypeCount} />
                <Stat label="Value sources" value={summary.customValueSourceCount} />
                <Stat label="Strategies" value={summary.strategyCount} />
                <Stat label="Environments" value={summary.environmentCount} />
              </div>
            </section>

            <section className={`${PANEL} flex min-h-0 flex-1 flex-col overflow-hidden`}>
              <div className="border-b border-border-subtle px-4 py-3">
                <h3 className="text-sm font-medium text-text">Entities in snapshot</h3>
                <p className="text-xs text-text-muted">{summary.entities.length} definition(s)</p>
              </div>
              {summary.entities.length === 0 ? (
                <p className="px-4 py-6 text-sm text-text-muted">No entities in this snapshot.</p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto show-scrollbar">
                  {summary.entities.map((entity) => (
                    <li
                      key={entity.id}
                      className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-2.5 text-sm last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-medium text-text">{entity.id}</div>
                        <div className="truncate text-text-muted">{entity.displayName}</div>
                      </div>
                      <div className="shrink-0 font-mono text-xs text-text-faint">{entity.rootTable || "—"}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </div>
    </ModalShell>
  )
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-elevated/30 px-3 py-2 text-center">
      <div className="font-mono text-lg font-semibold tabular-nums text-text">{value}</div>
      <div className="text-xs text-text-muted">{label}</div>
    </div>
  )
}
