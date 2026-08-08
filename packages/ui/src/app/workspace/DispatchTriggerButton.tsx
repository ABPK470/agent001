/**
 * Toolbar Dispatch trigger — compact ⌘K badge only (no mock search field).
 * Icon + letter pairing matches catalog-shortcut-hint glyphs — no keycap boxes.
 */

import { Command } from "lucide-react"
import { detectModHint } from "../../lib/keymap"
import { openWidgetCatalogHint } from "../types"

export function DispatchTriggerButton({ onClick }: { onClick: () => void }) {
  const mod = detectModHint()
  const hint = openWidgetCatalogHint(mod)

  return (
    <button
      type="button"
      className="toolbar-ops-btn toolbar-dispatch-trigger"
      onClick={onClick}
      title={`Open Dispatch (${hint})`}
      aria-label={`Open Dispatch (${hint})`}
    >
      <span className="toolbar-dispatch-trigger__keys" aria-hidden>
        {mod === "⌘" ? (
          <span className="toolbar-dispatch-trigger__glyph">
            <Command strokeWidth={2.25} aria-hidden />
          </span>
        ) : (
          <span className="toolbar-dispatch-trigger__mod-word">Ctrl</span>
        )}
        <span className="toolbar-dispatch-trigger__key">K</span>
      </span>
    </button>
  )
}
