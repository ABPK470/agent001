/**
 * On-demand keymap (?) — App → Space → Tile → Max/Zen → Pane.
 */

import { useEffect } from "react"
import { useStore } from "../../state/store"
import { SHELL_BINDINGS, TRACE_DETAIL_HINTS, TRACE_TREE_HINTS } from "../../lib/keymap"
import { MODAL_OVERLAY_SCRIM_CLASS } from "../../widgets/entity-registry/modal-overlay"

export function KeymapSheet() {
  const open = useStore((s) => s.keymapSheetOpen)
  const setOpen = useStore((s) => s.setKeymapSheetOpen)

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      className={`keymap-sheet-overlay ${MODAL_OVERLAY_SCRIM_CLASS}`}
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div
        className="keymap-sheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="keymap-sheet__header">
          <h2 className="keymap-sheet__title">Keyboard</h2>
          <button
            type="button"
            className="keymap-sheet__close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            Esc
          </button>
        </header>

        <section className="keymap-sheet__section">
          <h3 className="keymap-sheet__section-title">App / Space / Tile</h3>
          <ul className="keymap-sheet__list">
            {SHELL_BINDINGS.map((binding) => (
              <li key={binding.id} className="keymap-sheet__row">
                <span className="keymap-sheet__keys">
                  {binding.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
                <span className="keymap-sheet__label">
                  {binding.label}
                  {binding.when ? ` · ${binding.when}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="keymap-sheet__section">
          <h3 className="keymap-sheet__section-title">Trace · tree pane</h3>
          <ul className="keymap-sheet__list">
            {TRACE_TREE_HINTS.map((hint) => (
              <li key={hint.label} className="keymap-sheet__row">
                <span className="keymap-sheet__keys">
                  {hint.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
                <span className="keymap-sheet__label">{hint.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="keymap-sheet__section">
          <h3 className="keymap-sheet__section-title">Trace · detail pane</h3>
          <ul className="keymap-sheet__list">
            {TRACE_DETAIL_HINTS.map((hint) => (
              <li key={`${hint.label}:${hint.keys.join("+")}`} className="keymap-sheet__row">
                <span className="keymap-sheet__keys">
                  {hint.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
                <span className="keymap-sheet__label">{hint.label}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
