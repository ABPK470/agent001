/**
 * Publish Catalog tip → sync runtime — confirmation with tip-vs-published diff.
 * Same Changes / CatalogJsonDiff dialect as catalog version detail (different job).
 */

import { CheckCircle2, GitCompareArrows, Loader2, Rocket, XCircle } from "lucide-react"
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
  firstCatalogDiffEntryKey,
  type CatalogDiffSection,
} from "../platform/CatalogDiffSections"
import { ACTION_BTN, META_TEXT, PANEL, TEXT_BTN } from "./chrome"
import { ModalShell } from "./ModalShell"

type PublishPhase = "idle" | "publishing" | "done"

/** Tip sections that enter the published SyncDefinition contract. */
const COMPILE_SECTIONS = new Set([
  "entities",
  "configs",
  "strategies",
  "flows",
  "actions",
  "valueSources",
  "phases",
])

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
  const [fromVersion, setFromVersion] = useState<number | null>(null)
  const [toVersion, setToVersion] = useState<number | null>(null)
  const [changeCount, setChangeCount] = useState(0)
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null)

  const tipVersion = publishStatus?.activeCatalogVersion ?? null
  const publishedVersion = publishStatus?.publishedCatalogVersion ?? null

  useEffect(() => {
    if (phase !== "idle" || tipVersion == null) {
      setSections([])
      setDiffBusy(false)
      setDiffError(null)
      return
    }
    let cancelled = false
    setDiffBusy(true)
    setDiffError(null)
    setOpenEntryKey(null)
    const against =
      publishedVersion != null && publishedVersion !== tipVersion
        ? publishedVersion
        : ("previous" as const)

    void api.getSyncCatalogVersionDiff(tipVersion, against).then(
      (res) => {
        if (cancelled) return
        const compileSections = res.diff.sections.filter((s) => COMPILE_SECTIONS.has(s.section))
        setSections(compileSections)
        setFromVersion(res.diff.fromVersion)
        setToVersion(res.diff.toVersion)
        setChangeCount(
          compileSections.reduce(
            (n, s) => n + s.creates.length + s.updates.length + s.deletes.length,
            0,
          ),
        )
        setOpenEntryKey(firstCatalogDiffEntryKey(compileSections))
        setDiffBusy(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setDiffError(e instanceof Error ? e.message : String(e))
        setSections([])
        setDiffBusy(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [phase, tipVersion, publishedVersion])

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

  const compareLabel =
    tipVersion == null
      ? "Catalog tip"
      : publishedVersion != null && fromVersion === publishedVersion
        ? `Tip v${toVersion ?? tipVersion} vs published v${publishedVersion}`
        : fromVersion != null
          ? `Tip v${toVersion ?? tipVersion} vs v${fromVersion}`
          : `Tip v${tipVersion}`

  const subtitle =
    phase === "idle"
      ? operationalOnly
        ? "Environment changes are live at preview/execute — Publish is not required for them."
        : "Compose Catalog tip into the sync runtime for preview and execute. Environments and connectors stay live."
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
      <>
        <button type="button" className={`${TEXT_BTN} flex-1 justify-center`} onClick={handleClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`${ACTION_BTN} flex-1`}
          onClick={() => void confirmPublish()}
        >
          <Rocket size={14} /> Publish
        </button>
      </>
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
      size="default"
      footer={footer}
    >
      {phase === "idle" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
          <section className={`${PANEL} shrink-0 space-y-3 p-4`}>
            <div className="flex items-center justify-center gap-8 font-mono text-sm tabular-nums">
              <div className="text-center">
                <div className="text-lg font-semibold text-text">{unpublished.length}</div>
                <div className={`text-xs ${META_TEXT}`}>entities to republish</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-text">{entityCount}</div>
                <div className={`text-xs ${META_TEXT}`}>entities total</div>
              </div>
              {changeCount > 0 && (
                <div className="text-center">
                  <div className="text-lg font-semibold text-text">{changeCount}</div>
                  <div className={`text-xs ${META_TEXT}`}>catalog changes</div>
                </div>
              )}
            </div>
            {compileSections.length > 0 && (
              <p className={`text-center ${META_TEXT}`}>
                Tip changed:{" "}
                {compileSections.map((id) => SECTION_LABELS[id] ?? id).join(", ")}
              </p>
            )}
            {unpublished.length > 0 && (
              <p className={`text-center ${META_TEXT}`}>
                Affected:{" "}
                <span className="font-mono text-text">
                  {unpublished.map((item) => item.id).join(", ")}
                </span>
              </p>
            )}
            {operationalOnly && (
              <p className={`text-center ${META_TEXT}`}>
                Catalog tip also has environment updates (live — not listed below).
              </p>
            )}
          </section>

          <section className={`${PANEL} flex min-h-0 flex-1 flex-col overflow-hidden`}>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-medium text-text">
                  <GitCompareArrows size={14} className="text-text-muted" />
                  Changes
                </h3>
                <p className={`mt-0.5 ${META_TEXT}`}>
                  {compareLabel}
                  {changeCount > 0
                    ? ` · ${changeCount} change${changeCount === 1 ? "" : "s"}`
                    : ""}
                  {" · compile sections only"}
                </p>
              </div>
            </div>

            {diffBusy ? (
              <div className="flex flex-1 items-center justify-center gap-2 px-4 py-10 text-sm text-text-muted">
                <Loader2 size={16} className="animate-spin" />
                Loading tip vs published diff…
              </div>
            ) : diffError ? (
              <p className="px-4 py-6 text-sm text-error">{diffError}</p>
            ) : tipVersion == null ? (
              <p className={`px-4 py-6 text-sm ${META_TEXT}`}>
                No catalog tip version yet — Publish will compile the current tip.
              </p>
            ) : (
              <CatalogDiffSections
                sections={sections}
                openEntryKey={openEntryKey}
                onToggleEntry={setOpenEntryKey}
                changesOnly
                emptyMessage="No compile-relevant tip changes vs the last publish. Publish still recompiles the full bundle."
              />
            )}
          </section>

          <p className="shrink-0 text-center text-sm leading-relaxed text-text-muted/60">
            Invalid flows block publish for that entity. Warnings are logged but do not stop the bundle.
          </p>
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
