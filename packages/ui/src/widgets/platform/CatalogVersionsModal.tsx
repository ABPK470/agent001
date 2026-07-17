/**
 * CatalogVersionsModal — browse sync catalog versions and rollback via import gate.
 */

import { History, Loader2, RotateCcw } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import { EmptyState } from "../../components/EmptyState"
import { ModalShell } from "../entity-registry/ModalShell"
import { modalViewerPanelClass } from "../entity-registry/modal-overlay"
import { useIsMobile } from "../../hooks/useIsMobile"
import { CatalogRollbackGate } from "./CatalogRollbackGate"

export function CatalogVersionsModal({
  onClose,
  onRolledBack,
}: {
  onClose: () => void
  onRolledBack: () => void
}): JSX.Element {
  const isMobile = useIsMobile()
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof api.listSyncCatalogVersions>>["versions"]>([])
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null)

  async function load(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.listSyncCatalogVersions()
      setActiveVersion(res.activeVersion)
      setVersions(res.versions)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load() }, [])

  return (
    <>
      <ModalShell
        title="Configuration versions"
        subtitle="Full sync catalog snapshots. Export always reflects the active version. Rollback applies a prior snapshot as a new version."
        icon={<History size={20} className="text-text-muted" />}
        onClose={onClose}
        widthClass={modalViewerPanelClass(isMobile)}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4 pt-2">
          {err && <p className="text-sm text-error">{err}</p>}
          {busy ? (
            <EmptyState icon={Loader2} message="Loading…" className="[&_svg]:animate-spin" />
          ) : versions.length === 0 ? (
            <EmptyState icon={History} message="No versions recorded yet." />
          ) : (
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto show-scrollbar">
              {versions.map((entry) => (
                <li
                  key={entry.version}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${entry.isActive ? "border-accent/40 bg-accent/5" : "border-border-subtle"}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono font-medium text-text">v{entry.version}{entry.isActive ? " · active" : ""}</div>
                    <div className="truncate text-text-muted">{entry.reason}</div>
                    <div className="text-xs text-text-faint">{entry.createdBy} · {new Date(entry.createdAt).toLocaleString()}</div>
                  </div>
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
          {activeVersion !== null && (
            <p className="text-xs text-text-faint">Active version: {activeVersion}</p>
          )}
        </div>
      </ModalShell>

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
