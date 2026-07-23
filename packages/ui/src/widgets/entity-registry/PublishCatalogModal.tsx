/**
 * Publish Catalog tip → sync runtime — confirmation with live tip-vs-published diff.
 * Diff SoT is publish-preview (live tip), not catalog version-history snapshots.
 */

import { CheckCircle2, Loader2, Rocket, XCircle } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../client/index"
import type {
  PublishSyncDefinitionsResponse,
  SyncDefinitionAdminItem,
  SyncPublishStatus,
} from "../../types"
import {
  CatalogDiffSections,
  type CatalogDiffSection,
} from "../platform/CatalogDiffSections"
import { ACTION_BTN, FIELD_LABEL, PANEL, TEXT_BTN } from "./chrome"
import { ModalShell } from "./ModalShell"
import { MODAL_TALL_HEIGHT } from "./modal-overlay"

type PublishPhase = "idle" | "publishing" | "done"

const SECTION_LABELS: Record<string, string> = {
  entities: "Entities",
  configs: "Run configs",
  strategies: "Strategies",
  flows: "Flows",
  actions: "Actions",
  valueSources: "Value sources",
  phases: "Phases",
  environments: "Environments",
}

const PUBLISH_MODAL_PANEL =
  `w-full max-w-4xl ${MODAL_TALL_HEIGHT} min-h-[36rem] flex flex-col overflow-hidden`

function MetaCell({
  label,
  value,
  mono = true,
  grow = false,
}: {
  label: string
  value: string
  mono?: boolean
  /** Let long values wrap instead of truncating. */
  grow?: boolean
}): JSX.Element {
  return (
    <div className={grow ? "min-w-0 flex-1 basis-[12rem]" : "shrink-0"}>
      <p className={FIELD_LABEL}>{label}</p>
      <p
        className={[
          "mt-0.5 text-sm font-medium text-text",
          grow ? "break-words" : "whitespace-nowrap",
          mono ? "font-mono tabular-nums" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </p>
    </div>
  )
}

export function PublishCatalogModal({
  entityCount,
  unpublished,
  publishStatus = null,
  onClose,
  onPublished,
}: {
  entityCount: number
  unpublished: SyncDefinitionAdminItem[]
  publishStatus?: SyncPublishStatus | null
  onClose: () => void
  onPublished?: (result: PublishSyncDefinitionsResponse) => void
}): JSX.Element {
  const [phase, setPhase] = useState<PublishPhase>("idle")
  const [result, setResult] = useState<PublishSyncDefinitionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [sections, setSections] = useState<CatalogDiffSection[]>([])
  const [changeCount, setChangeCount] = useState(0)
  const [previewNeedsPublish, setPreviewNeedsPublish] = useState(false)
  const [tipVersion, setTipVersion] = useState<number | null>(
    publishStatus?.activeCatalogVersion ?? null,
  )
  const [publishedVersion, setPublishedVersion] = useState<number | null>(
    publishStatus?.publishedCatalogVersion ?? null,
  )
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== "idle") return
    let cancelled = false
    setDiffBusy(true)
    setDiffError(null)
    setOpenEntryKey(null)
    void api.getSyncPublishPreview().then(
      (preview) => {
        if (cancelled) return
        setSections(preview.sections)
        setChangeCount(preview.changeCount)
        setTipVersion(preview.activeCatalogVersion)
        setPublishedVersion(preview.publishedCatalogVersion)
        setPreviewNeedsPublish(preview.catalogNeedsPublish)
        setDiffBusy(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setDiffError(e instanceof Error ? e.message : String(e))
        setSections([])
        setDiffBusy(false)
      },
    ).catch((err: unknown) => { console.error("[mia]", err) })
    return () => {
      cancelled = true
    }
  }, [phase])

  async function confirmPublish(): Promise<void> {
    setPhase("publishing")
    setError(null)
    try {
      const res = await api.publishSyncDefinitions()
      setResult(res)
      setPhase("done")
      onPublished?.(res)
    } catch (e) {
      const apiError = e as Error & { stderr?: string[] }
      setError(apiError.message)
      if (apiError.stderr?.length) {
        setResult({
          publishedAt: "",
          publishedVersion: "",
          definitionCount: 0,
          publishedStorage: "sqlite",
          publishedBundlePath: "",
          stdout: [],
          stderr: apiError.stderr,
        })
      }
      setPhase("done")
    }
  }

  function handleClose(): void {
    if (phase === "publishing") return
    onClose()
  }

  const title =
    phase === "idle" ? "Publish catalog"
      : phase === "publishing" ? "Publishing…"
        : error ? "Publish failed"
          : "Publish complete"

  const compileSections = publishStatus?.dirtyCompileSections ?? []
  const operationalOnly = Boolean(publishStatus?.operationalCatalogAhead)
  const stampDrift =
    tipVersion != null
    && publishedVersion != null
    && tipVersion !== publishedVersion
    && changeCount === 0
    && previewNeedsPublish

  const tipLabel = tipVersion != null ? `v${tipVersion}` : "—"
  const publishedLabel = publishedVersion != null ? `v${publishedVersion}` : "—"
  const tipSectionsLabel =
    compileSections.length > 0
      ? compileSections.map((id) => SECTION_LABELS[id] ?? id).join(", ")
      : "—"

  const subtitle =
    phase === "idle"
      ? "Compose Catalog tip into the sync runtime for preview and execute."
      : phase === "publishing"
        ? "Composing Catalog tip into the sync runtime…"
        : undefined

  const headerIcon =
    phase === "idle" ? <Rocket size={20} className="text-text-muted" />
      : phase === "publishing" ? <Loader2 size={20} className="animate-spin text-text-muted" />
        : error ? <XCircle size={20} className="text-error" />
          : <CheckCircle2 size={20} className="text-success" />

  const footer =
    phase === "idle" ? (
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-sm text-xs leading-relaxed text-text-muted/55">
          Invalid flows block that entity. Warnings are logged and do not stop the bundle.
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={`${TEXT_BTN} min-w-[5.5rem] justify-center`} onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${ACTION_BTN} min-w-[7rem]`}
            onClick={() => void confirmPublish().catch((err: unknown) => { console.error("[mia]", err) })}
          >
            <Rocket size={14} /> Publish
          </button>
        </div>
      </div>
    ) : phase === "done" ? (
      <button type="button" className={`${ACTION_BTN} w-full`} onClick={handleClose}>
        Close
      </button>
    ) : undefined

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      icon={headerIcon}
      onClose={handleClose}
      widthClass={PUBLISH_MODAL_PANEL}
      footer={footer}
    >
      {phase === "idle" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-start gap-x-8 gap-y-3 border-b border-border-subtle px-6 py-3">
            <MetaCell label="Tip" value={tipLabel} />
            <MetaCell label="Published" value={publishedLabel} />
            <MetaCell label="Changes" value={String(changeCount)} />
            <MetaCell label="Entities" value={`${unpublished.length} / ${entityCount}`} />
            <MetaCell label="Tip sections" value={tipSectionsLabel} mono={false} grow />
          </div>
          {(stampDrift || operationalOnly) && (
            <div className="shrink-0 space-y-1 border-b border-warning/30 bg-warning/10 px-6 py-2 text-xs leading-relaxed text-warning">
              {stampDrift && (
                <p>
                  Tip stamp is ahead of publish, but live tip content matches the published
                  snapshot. Publish reconciles the stamp (v{publishedVersion} → v{tipVersion}).
                </p>
              )}
              {operationalOnly && (
                <p>
                  Environment tip updates are live at preview/execute — not listed in the diff
                  below.
                </p>
              )}
            </div>
          )}

          {diffBusy ? (
            <div className="flex flex-1 items-center justify-center gap-2 px-6 py-10 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading tip vs published diff…
            </div>
          ) : diffError ? (
            <p className="px-6 py-6 text-sm text-error">{diffError}</p>
          ) : (
            <CatalogDiffSections
              sections={sections}
              openEntryKey={openEntryKey}
              onToggleEntry={setOpenEntryKey}
              changesOnly
              fill
              emptyMessage={
                stampDrift
                  ? "No live compile delta — Publish only advances the published catalog stamp to the active tip."
                  : "No compile-relevant tip changes vs the last publish. Publish still recompiles the full bundle."
              }
            />
          )}
        </div>
      )}

      {phase === "publishing" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <Loader2 size={22} className="animate-spin text-text-muted" />
          <p className="text-sm text-text-muted">Composing Catalog tip into the sync runtime…</p>
        </div>
      )}

      {phase === "done" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          {error ? (
            <p className="text-sm leading-relaxed text-error">{error}</p>
          ) : result ? (
            <p className="text-sm leading-relaxed text-text-muted">
              Published sync bundle ·{" "}
              <span className="font-semibold text-text">{result.definitionCount}</span>{" "}
              definition{result.definitionCount === 1 ? "" : "s"}.
            </p>
          ) : null}

          {result && result.stderr.length > 0 && (
            <div className={`${PANEL} max-h-40 overflow-y-auto px-3 py-2`}>
              <p className="field-label mb-1.5">
                {result.stderr.some((line) => line.startsWith("Refusing to publish"))
                  ? "Errors"
                  : "Warnings"}
              </p>
              <ul className="space-y-1 font-mono text-sm leading-snug text-text-muted">
                {result.stderr.map((line) => (
                  <li
                    key={line}
                    className={line.startsWith("Refusing to publish") ? "text-error" : undefined}
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  )
}
