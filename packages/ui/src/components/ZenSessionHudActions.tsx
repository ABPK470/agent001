/**
 * Shared zen session trailing strip — Save Zen Space + Exit.
 * Per-widget HUDs own search/filters; this is the immersion chrome.
 * Presentation-only — parents wire save/exit.
 */

import { Bookmark, X } from "lucide-react"

export function ZenSessionHudActions({
  onExitZen,
  onSaveZen,
  /** When already on a zen:* view — bookmark updates that Space. */
  saveLabel = "Save Zen Space",
}: {
  onExitZen: () => void
  onSaveZen: () => void
  saveLabel?: string
}) {
  return (
    <>
      <button
        type="button"
        className="trace-zen-hud__icon-btn"
        title={saveLabel}
        aria-label={saveLabel}
        onClick={onSaveZen}
      >
        <Bookmark size={14} strokeWidth={1.75} />
      </button>
      <span className="trace-zen-hud__hint" aria-hidden>
        <kbd>Esc</kbd>
      </span>
      <button
        type="button"
        className="trace-zen-hud__icon-btn"
        title="Exit Zen (Esc)"
        aria-label="Exit Zen"
        onClick={onExitZen}
      >
        <X size={14} />
      </button>
    </>
  )
}
