/**
 * Publish definitions — confirmation modal (same pattern as sync execute).
 */

import { CheckCircle2, Loader2, Rocket, X, XCircle } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../api"
import type { PublishSyncDefinitionsResponse } from "../../types"

type PublishPhase = "idle" | "publishing" | "done"

export function PublishDefinitionsModal({
  entityCount,
  onClose,
  onPublished,
}: {
  entityCount: number
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
      setError(e instanceof Error ? e.message : String(e))
      setPhase("done")
    }
  }

  function handleClose(): void {
    if (phase === "publishing") return
    onClose()
  }

  const title =
    phase === "idle" ? "Publish definitions"
      : phase === "publishing" ? "Publishing…"
        : error ? "Publish failed"
          : "Publish complete"

  const headerIcon =
    phase === "idle" ? <Rocket size={20} className="text-accent" />
      : phase === "publishing" ? <Loader2 size={20} className="animate-spin text-accent" />
        : error ? <XCircle size={20} className="text-error" />
          : <CheckCircle2 size={20} className="text-success" />

  return createPortal(
    <div
      className="exec-modal-overlay fixed inset-0 z-[200] flex items-center justify-center"
      onClick={phase === "publishing" ? undefined : handleClose}
    >
      <div
        className="exec-modal-shell--idle bg-surface flex min-h-0 flex-col shadow-2xl overflow-hidden rounded-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 sm:pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {headerIcon}
            <h3 className="text-lg font-semibold text-text truncate">{title}</h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={phase === "publishing"}
            className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors shrink-0 disabled:opacity-40"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {phase === "idle" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto">
              <div className="px-4 sm:px-5 pt-4 pb-3 text-justify">
                <p className="text-sm text-text-muted leading-relaxed">
                  Compile and publish{" "}
                  <span className="font-semibold text-text">all entity definitions</span>{" "}
                  to the runtime sync bundle. Preview and execute use the published version.
                </p>
              </div>

              <div className="mx-4 sm:mx-5 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
                <div className="flex items-center justify-center gap-5 font-mono text-sm tabular-nums">
                  <div className="text-center">
                    <div className="text-lg font-semibold text-text">{entityCount}</div>
                    <div className="text-xs text-text-muted">entities</div>
                  </div>
                </div>
              </div>

              <div className="px-4 sm:px-5 pt-3 pb-4 text-center">
                <p className="text-sm text-text-muted/50 leading-relaxed">
                  Invalid flows block publish for that entity. Warnings are logged but do not stop the bundle.
                </p>
              </div>
            </div>

            <div className="shrink-0 border-t border-border-subtle px-4 sm:px-5 py-4 flex gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="flex-1 h-9 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPublish()}
                className="flex-1 h-9 text-sm text-text bg-accent hover:bg-accent-hover rounded-lg flex items-center justify-center gap-1.5 transition-colors"
              >
                <Rocket size={14} /> Publish
              </button>
            </div>
          </div>
        )}

        {phase === "publishing" && (
          <div className="flex flex-1 flex-col items-center justify-center px-4 sm:px-5 py-10 text-center text-sm text-text-muted">
            Compiling entity registry and writing published bundle…
          </div>
        )}

        {phase === "done" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-4 sm:px-5 pt-4 pb-4">
              {error ? (
                <p className="text-sm text-error leading-relaxed">{error}</p>
              ) : result ? (
                <p className="text-sm text-text-muted leading-relaxed">
                  Published{" "}
                  <span className="font-semibold text-text">{result.definitionCount}</span>{" "}
                  definition{result.definitionCount === 1 ? "" : "s"}.
                </p>
              ) : null}

              {result && result.stderr.length > 0 && (
                <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-border-subtle bg-overlay-1 px-3 py-2">
                  <p className="field-label mb-1.5">
                    Warnings
                  </p>
                  <ul className="space-y-1 text-sm leading-snug text-text-muted font-mono">
                    {result.stderr.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border-subtle px-4 sm:px-5 py-4">
              <button
                type="button"
                onClick={handleClose}
                className="w-full h-9 text-sm text-text bg-accent hover:bg-accent-hover rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
