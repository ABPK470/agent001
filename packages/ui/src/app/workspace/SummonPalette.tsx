/**
 * Spotlight Summon — peek by default; Keep explicitly adds to the active Space.
 * Renders above the shell (strong scrim) — not as a layout tile.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { PRODUCT_BUNDLES } from "../../lib/spaces"
import { SUMMON_HINTS } from "../../lib/keymap"
import type { WidgetType } from "../../types"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
import { MODAL_OVERLAY_SCRIM_CLASS } from "../../widgets/entity-registry/modal-overlay"
import {
  filterSummonItems,
  listSummonItems,
  summonItemKey,
  type SummonItem,
} from "./summon-items"

const SECTION_ORDER: Array<{ kind: SummonItem["kind"]; label: string }> = [
  { kind: "space", label: "Spaces" },
  { kind: "bundle", label: "Bundles" },
  { kind: "widget", label: "Widgets" },
]

export function SummonPalette() {
  const summonOpen = useStore((s) => s.summonOpen)
  const setSummonOpen = useStore((s) => s.setSummonOpen)
  const openModalWidget = useStore((s) => s.openModalWidget)
  const activeRunId = useStore((s) => s.activeRunId)
  const requestWorkspaceShell = useStore((s) => s.requestWorkspaceShell)
  const callSpace = useLayoutStore((s) => s.callSpace)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const setFocusedTile = useLayoutStore((s) => s.setFocusedTile)
  const toggleTileMaximized = useLayoutStore((s) => s.toggleTileMaximized)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)

  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo(() => filterSummonItems(query, listSummonItems()), [query])

  useEffect(() => {
    if (!summonOpen) return
    ensureProductSpaces()
    setQuery("")
    setSelected(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [ensureProductSpaces, summonOpen])

  useEffect(() => {
    setSelected(0)
  }, [query])

  useEffect(() => {
    if (!summonOpen) return
    const shell = document.querySelector(".app-shell-view")
    if (!(shell instanceof HTMLElement)) return
    shell.setAttribute("inert", "")
    return () => shell.removeAttribute("inert")
  }, [summonOpen])

  if (!summonOpen) return null

  const activeView = views.find((view) => view.id === activeViewId)
  const current = items[selected] ?? null

  function dismiss() {
    setSummonOpen(false)
  }

  function focusExistingWidget(type: WidgetType): boolean {
    const tile = activeView?.tiles.find((t) => t.type === type)
    if (!tile) return false
    setFocusedTile(tile.id)
    toggleTileMaximized(activeViewId, tile.id)
    dismiss()
    return true
  }

  function keepTypes(types: readonly WidgetType[]) {
    for (const type of types) {
      if (!activeView?.tiles.some((tile) => tile.type === type)) {
        addWidget(activeViewId, type)
      }
    }
    dismiss()
  }

  function peekItem(item: SummonItem) {
    if (item.kind === "space") {
      requestWorkspaceShell()
      callSpace(item.id)
      dismiss()
      return
    }
    const peekType = item.kind === "bundle" ? item.peekType : item.type
    if (focusExistingWidget(peekType)) return
    openModalWidget(peekType, activeRunId ?? undefined)
  }

  function keepItem(item: SummonItem) {
    if (item.kind === "space") {
      requestWorkspaceShell()
      callSpace(item.id)
      dismiss()
      return
    }
    requestWorkspaceShell()
    if (item.kind === "widget") {
      if (activeView?.tiles.some((tile) => tile.type === item.type)) {
        focusExistingWidget(item.type)
        return
      }
      keepTypes([item.type])
      return
    }
    const def = PRODUCT_BUNDLES.find((bundle) => bundle.id === item.id)
    keepTypes(def?.widgets ?? [item.peekType])
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelected((i) => Math.min(Math.max(items.length - 1, 0), i + 1))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (!current) return
      if (event.metaKey || event.ctrlKey) keepItem(current)
      else peekItem(current)
    }
  }

  return (
    <div
      className={`summon-palette-overlay ${MODAL_OVERLAY_SCRIM_CLASS}`}
      role="presentation"
      onClick={dismiss}
    >
      <div
        className="summon-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Summon"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="summon-palette__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Go to a Space, open a bundle, or peek a widget…"
          aria-label="Summon search"
        />
        <p className="summon-palette__hint">
          Enter peeks (layout untouched) · ⌘/Ctrl+Enter keeps in this Space · Esc leaves
        </p>
        <div className="summon-palette__list" role="listbox">
          {SECTION_ORDER.map((section) => {
            const sectionItems = items.filter((item) => item.kind === section.kind)
            if (sectionItems.length === 0) return null
            return (
              <div key={section.kind} className="summon-palette__section-block">
                <div className="summon-palette__section">{section.label}</div>
                {sectionItems.map((item) => {
                  const index = items.indexOf(item)
                  return (
                    <button
                      key={summonItemKey(item)}
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      className={`summon-palette__row${index === selected ? " is-selected" : ""}`}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => peekItem(item)}
                    >
                      <span className="summon-palette__name">{item.name}</span>
                      <span className="summon-palette__desc">{item.desc}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
          {items.length === 0 ? (
            <div className="summon-palette__empty">No matches</div>
          ) : null}
        </div>
        <ComposerKbdFooter hints={SUMMON_HINTS} />
      </div>
    </div>
  )
}
