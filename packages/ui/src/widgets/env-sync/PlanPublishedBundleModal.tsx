import { BookOpen, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"

import { api } from "../../client/index"
import { JsonViewer } from "../../components/JsonViewer"
import type { PublishedSyncDefinition, SyncPlan } from "../../types"
import { Err, ModalShell } from "./chrome"

export function PlanPublishedBundleModal({
  plan,
  onClose,
}: {
  plan: SyncPlan
  onClose: () => void
}) {
  const entityId = plan.executionContract.definitionId
  const pinnedVersion = plan.executionContract.definitionPublishedVersion
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bundlePath, setBundlePath] = useState<string | null>(null)
  const [bundlePublishedAt, setBundlePublishedAt] = useState<string | null>(null)
  const [bundlePublishedVersion, setBundlePublishedVersion] = useState<string | null>(null)
  const [definition, setDefinition] = useState<PublishedSyncDefinition | null>(null)

  useEffect(() => {
    let dead = false
    setLoading(true)
    setError(null)
    void api
      .syncPublishedBundleEntry(entityId)
      .then((res) => {
        if (dead) return
        if (res.error) {
          setError(res.error)
          setBundlePath(res.bundlePath ?? null)
          return
        }
        setBundlePath(res.bundlePath ?? null)
        setBundlePublishedAt(res.bundlePublishedAt ?? null)
        setBundlePublishedVersion(res.bundlePublishedVersion ?? null)
        setDefinition(res.definition ?? null)
      })
      .catch((err) => {
        if (!dead) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!dead) setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [entityId])

  const versionMismatch =
    bundlePublishedVersion != null &&
    pinnedVersion !== bundlePublishedVersion

  return (
    <ModalShell
      title="Published definition bundle"
      subtitle={bundlePath ?? `sync-definitions/published/definitions.bundle.json · ${entityId}`}
      icon={<BookOpen size={20} className="text-text-muted" />}
      size="focus"
      onClose={onClose}
    >
      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          Reading published bundle…
        </div>
      )}
      {!loading && error && <Err>{error}</Err>}
      {!loading && !error && definition && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 overflow-hidden">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm shrink-0">
            <div>
              <span className="text-text-muted">Plan pinned version</span>
              <p className="font-mono text-text mt-0.5 truncate" title={pinnedVersion}>{pinnedVersion}</p>
            </div>
            <div>
              <span className="text-text-muted">Bundle on disk</span>
              <p className="font-mono text-text mt-0.5 truncate" title={bundlePublishedVersion ?? undefined}>
                {bundlePublishedVersion ?? "—"}
              </p>
            </div>
            {bundlePublishedAt && (
              <div className="col-span-2">
                <span className="text-text-muted">Bundle published at</span>
                <p className="font-mono text-text mt-0.5">{bundlePublishedAt}</p>
              </div>
            )}
          </div>
          {versionMismatch && (
            <div className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning shrink-0">
              The on-disk bundle version differs from the version this plan was compiled with. The JSON below is the
              current published bundle entry — not a historical snapshot stored in the database.
            </div>
          )}
          <div className="flex-1 min-h-0">
            <JsonViewer value={definition} label="definition" defaultExpandDepth={2} maxHeight={560} />
          </div>
        </div>
      )}
    </ModalShell>
  )
}
