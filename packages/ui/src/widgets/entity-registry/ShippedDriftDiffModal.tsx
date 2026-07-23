/**
 * Tip vs shipped JSON diff for a built-in catalog row marked Modified.
 */

import { GitCompareArrows, Loader2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import { formatApiError } from "../../lib/api-error"
import { CatalogJsonDiff } from "../platform/CatalogJsonDiff"
import { ACTION_BTN, META_TEXT } from "./chrome"
import { ModalShell } from "./ModalShell"

export type ShippedDriftDiffKind = "flows" | "actions" | "valueSources"

const KIND_LABEL: Record<ShippedDriftDiffKind, string> = {
  flows: "Flow",
  actions: "Action",
  valueSources: "Source",
}

export function ShippedDriftDiffModal({
  kind,
  id,
  onClose,
  stackLevel = 1,
}: {
  kind: ShippedDriftDiffKind
  id: string
  onClose: () => void
  stackLevel?: number
}): JSX.Element {
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState(id)
  const [shippedJson, setShippedJson] = useState<string | null>(null)
  const [tipJson, setTipJson] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    api.getSyncMetadataShippedDiff(kind, id).then(
      (diff) => {
        if (cancelled) return
        setLabel(diff.label)
        setShippedJson(diff.shippedJson)
        setTipJson(diff.tipJson)
        setBusy(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setError(formatApiError(e))
        setBusy(false)
      },
    ).catch((err: unknown) => { console.error("[mia]", err) })
    return () => {
      cancelled = true
    }
  }, [kind, id])

  return (
    <ModalShell
      title={`${KIND_LABEL[kind]} · Modified`}
      subtitle={`${label} · tip vs shipped sync-metadata.json`}
      icon={<GitCompareArrows size={20} className="text-text-muted" />}
      onClose={onClose}
      size="detail"
      stackLevel={stackLevel}
      footer={(
        <button type="button" className={`${ACTION_BTN} w-full`} onClick={onClose}>
          Close
        </button>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
        <p className={`${META_TEXT} text-text-muted`}>
          <span className="text-error">− shipped</span>
          {" · "}
          <span className="text-success">+ database tip</span>
          {" · "}
          Database tip remains the source of truth.
        </p>
        {busy ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading diff…
          </div>
        ) : error ? (
          <p className="text-sm text-error">{error}</p>
        ) : shippedJson == null ? (
          <div className="space-y-2">
            <p className="text-sm text-text-muted">
              No matching entry in shipped artifacts — tip-only built-in.
            </p>
            <CatalogJsonDiff beforeJson={null} afterJson={tipJson} changesOnly className="max-h-[min(28rem,50vh)]" />
          </div>
        ) : (
          <CatalogJsonDiff
            beforeJson={shippedJson}
            afterJson={tipJson}
            changesOnly
            className="max-h-[min(28rem,50vh)]"
          />
        )}
      </div>
    </ModalShell>
  )
}
