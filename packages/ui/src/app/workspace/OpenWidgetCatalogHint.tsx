/**
 * Visual ⌘K / Ctrl+K for Summon — dual tactile micro-keycaps.
 */

import { Command } from "lucide-react"
import { detectModHint } from "../types"

export function OpenWidgetCatalogHintMark() {
  const mod = detectModHint()
  if (mod === "⌘") {
    return (
      <span className="catalog-shortcut-hint" aria-hidden>
        <kbd className="catalog-shortcut-hint__key catalog-shortcut-hint__key--mod">
          <span className="catalog-shortcut-hint__key-glyph">
            <Command strokeWidth={2.25} aria-hidden />
          </span>
        </kbd>
        <kbd className="catalog-shortcut-hint__key catalog-shortcut-hint__key--char">
          <span className="catalog-shortcut-hint__key-glyph">K</span>
        </kbd>
      </span>
    )
  }
  return (
    <span className="catalog-shortcut-hint" aria-hidden>
      <kbd className="catalog-shortcut-hint__key catalog-shortcut-hint__key--mod catalog-shortcut-hint__key--wide">
        <span className="catalog-shortcut-hint__key-glyph">Ctrl</span>
      </kbd>
      <kbd className="catalog-shortcut-hint__key catalog-shortcut-hint__key--char">
        <span className="catalog-shortcut-hint__key-glyph">K</span>
      </kbd>
    </span>
  )
}
