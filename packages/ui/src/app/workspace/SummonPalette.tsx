/**
 * Spotlight Summon — peek by default; Keep explicitly adds to the active Space.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { PRODUCT_BUNDLES } from "../../lib/spaces"
import { SUMMON_HINTS } from "../../lib/keymap"
import type { WidgetType } from "../../types"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
import {
  filterSummonItems,
  listSummonItems,
  summonItemKey,
  type SummonItem,
} from "./summon-items"

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
      className="summon-palette-overlay"
      role="presentation"
      onClick={dismiss}
    >
      <div
        className="summon-palette"
        role="dialog"
        aria-label="Summon"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="summon-palette__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Summon a Space, bundle, or widget…"
          aria-label="Summon search"
        />
        <p className="summon-palette__hint">
          Peek — Esc to leave · ⌘/Ctrl+Enter keeps in this Space
        </p>
        <ul className="summon-palette__list" role="listbox">
          {items.map((item, index) => (
            <li key={summonItemKey(item)}>
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={`summon-palette__row${index === selected ? " is-selected" : ""}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => peekItem(item)}
              >
                <span className="summon-palette__kind">{item.kind}</span>
                <span className="summon-palette__name">{item.name}</span>
                <span className="summon-palette__desc">{item.desc}</span>
              </button>
            </li>
          ))}
          {items.length === 0 ? (
            <li className="summon-palette__empty">No matches</li>
          ) : null}
        </ul>
        <ComposerKbdFooter hints={SUMMON_HINTS} />
      </div>
    </div>
  )
}
