/**
 * Visual ⌘K / Ctrl+K mark for Add-to-layout — one shared border; mod matches K.
 */

import { Command } from "lucide-react"
import { detectModHint } from "../types"

export function OpenWidgetCatalogHintMark() {
  const mod = detectModHint()
  return (
    <kbd className="catalog-shortcut-hint" aria-hidden>
      {mod === "⌘" ? (
        <Command className="catalog-shortcut-hint__mod" strokeWidth={2.25} aria-hidden />
      ) : (
        <span className="catalog-shortcut-hint__ctrl">Ctrl</span>
      )}
      <span className="catalog-shortcut-hint__key">K</span>
    </kbd>
  )
}
