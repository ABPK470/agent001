import { PanelLeft, Plus, X } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { modalOverlayClass, MODAL_SURFACE_CLASS } from "../../widgets/entity-registry/modal-overlay"

export function ThreadsDrawerModal({
  open,
  onClose,
  onNewThread,
  children,
}: {
  open: boolean
  onClose: () => void
  onNewThread: () => void
  children: ReactNode
}): React.ReactElement | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={modalOverlayClass("detail", { zIndexClass: "z-[200]" })}
      role="presentation"
      onClick={onClose}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} flex w-full max-w-md max-h-[min(88dvh,28rem)] flex-col overflow-hidden ring-1 ring-border-subtle`}
        role="dialog"
        aria-modal="true"
        aria-label="Threads"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <PanelLeft size={18} strokeWidth={1.75} className="shrink-0 text-text-muted" />
            <h2 className="truncate text-base font-semibold text-text">Threads</h2>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onNewThread}
              className="thread-rail-toggle"
              title="New thread"
              aria-label="New thread"
            >
              <Plus size={17} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="thread-rail-toggle"
              title="Close"
              aria-label="Close threads"
            >
              <X size={17} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <div className="thread-rail-modal-body min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-1 sm:px-3 sm:pb-3">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
