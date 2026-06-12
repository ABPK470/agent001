import { Loader2, Trash2, X } from "lucide-react"
import type { JSX } from "react"
import { useEffect } from "react"
import { createPortal } from "react-dom"
import type { Thread } from "../../types"

export function DeleteThreadModal({
  thread,
  busy,
  onClose,
  onConfirm,
}: {
  thread: Thread
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const title = thread.title || "New thread"
  const count = thread.runCount ?? 0

  useEffect(() => {
    if (busy) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [busy, onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-scrim flex items-center justify-center p-2 sm:p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="bg-surface flex flex-col shadow-2xl overflow-hidden w-full h-auto max-h-full rounded-xl sm:rounded-2xl"
        style={{ maxWidth: "24rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Trash2 size={20} className="shrink-0 text-error" />
            <h3 className="text-lg font-semibold text-text truncate">Delete thread</h3>
          </div>
          {!busy && (
            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="px-5 pt-4 pb-3 text-center">
          <p className="text-sm text-text-muted">
            Permanently delete <span className="font-semibold text-text">{title}</span>
          </p>
        </div>

        <div className="mx-5 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
          <div className="flex items-center justify-center gap-5 font-mono text-sm tabular-nums">
            <div className="text-center">
              <div className="text-lg font-semibold text-text">{count}</div>
              <div className="text-xs text-text-muted">{count === 1 ? "run" : "runs"}</div>
            </div>
            {thread.pinned && (
              <div className="text-center">
                <div className="text-lg font-semibold text-accent">1</div>
                <div className="text-xs text-text-muted">pinned</div>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 pt-3 pb-1.5 text-center">
          <p className="text-[11px] text-text-muted/50 font-mono">
            runs · memory · traces · attachments · {thread.id.slice(0, 8)}
          </p>
        </div>

        <div className="px-5 pb-5 pt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 h-9 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 h-9 text-sm text-text bg-error hover:opacity-90 rounded-lg flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
