/**
 * Publish Catalog tip → sync runtime — confirmation with unpublished change preview.
 * Same ModalShell / Changes-list dialect as catalog version detail (not the same job).
 */

import { CheckCircle2, GitCompareArrows, Loader2, Rocket, XCircle } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../client/index"
import type { PublishSyncDefinitionsResponse, SyncDefinitionAdminItem } from "../../types"
import { ACTION_BTN, META_TEXT, PANEL, TEXT_BTN } from "./chrome"
import { ModalShell } from "./ModalShell"

type PublishPhase = "idle" | "publishing" | "done"

export function PublishCatalogModal({
  entityCount,
  unpublished,
  onClose,
  onPublished,
}: {
  entityCount: number
  unpublished: SyncDefinitionAdminItem[]
  onClose: () => void
  onPublished?: (result: PublishSyncDefinitionsResponse) => void
}): JSX.Element {
  const [phase, setPhase] = useState<PublishPhase>("idle")
  const [result, setResult] = useState<PublishSyncDefinitionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const subtitle =
    phase === "idle"
      ? "Compose Catalog tip into the sync runtime for preview and execute. Saving the Entity Registry alone does not publish."
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
      size="detail"
      footer={footer}
    >
      {phase === "idle" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
          <section className={`${PANEL} shrink-0 p-4`}>
            <div className="flex items-center justify-center gap-8 font-mono text-sm tabular-nums">
              <div className="text-center">
                <div className="text-lg font-semibold text-text">{unpublished.length}</div>
                <div className={`text-xs ${META_TEXT}`}>unpublished</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-text">{entityCount}</div>
                <div className={`text-xs ${META_TEXT}`}>entities total</div>
              </div>
            </div>
          </section>

          <section className={`${PANEL} flex min-h-0 flex-1 flex-col overflow-hidden`}>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-medium text-text">
                  <GitCompareArrows size={14} className="text-text-muted" />
                  Changes
                </h3>
                <p className={`mt-0.5 ${META_TEXT}`}>
                  {unpublished.length === 0
                    ? "No unpublished entity changes — publish still recompiles the full bundle"
                    : `${unpublished.length} unpublished entit${unpublished.length === 1 ? "y" : "ies"}`}
                </p>
              </div>
            </div>

            {unpublished.length > 0 ? (
              <ul className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto show-scrollbar">
                {unpublished.map((item) => (
                  <li key={item.id} className="px-4 py-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono font-medium text-text">{item.id}</div>
                        <div className={`truncate ${META_TEXT}`}>{item.displayName}</div>
                      </div>
                      <div className={`shrink-0 text-right ${META_TEXT}`}>
                        <div>rev {item.entityVersion}</div>
                        <div>
                          {item.publishedAt
                            ? `was ${new Date(item.publishedAt).toLocaleString()}`
                            : "never published"}
                        </div>
                      </div>
                    </div>
                    <div className={`mt-1 ${META_TEXT}`}>
                      Config updated {new Date(item.updatedAt).toLocaleString()}
                      {item.updatedBy ? ` · ${item.updatedBy}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`px-4 py-6 text-sm ${META_TEXT}`}>
                No unpublished entity changes detected. Publish still recompiles the full bundle.
              </p>
            )}
          </section>

          <p className={`shrink-0 text-center text-sm leading-relaxed text-text-muted/60`}>
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
