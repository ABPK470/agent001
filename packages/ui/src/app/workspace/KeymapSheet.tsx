/**
 * Keymap sheet (?) — one fixed two-column board (Pane | Shell).
 * Search filters both columns; Esc clears then dismisses.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Search } from "lucide-react"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import {
  filterShortcutRegistry,
  resolveKeyCaptions,
  resolveKeymapActiveContext,
  SHORTCUT_REGISTRY,
  type KbdHint,
  type ShortcutItem,
} from "../../lib/keymap"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
import { getWidgetDefinition } from "./widget-definitions"

export function KeymapSheet() {
  const open = useStore((s) => s.keymapSheetOpen)
  const setOpen = useStore((s) => s.setKeymapSheetOpen)
  const traceOperatorPane = useStore((s) => s.traceOperatorPane)

  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenTileId = useLayoutStore((s) => s.zenTileId)

  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const activeView = views.find((view) => view.id === activeViewId)
  const focusedTile = focusedTileId
    ? activeView?.tiles.find((tile) => tile.id === focusedTileId)
    : undefined
  const widgetLabel = focusedTile
    ? getWidgetDefinition(focusedTile.type).label
    : null

  const context = useMemo(
    () =>
      resolveKeymapActiveContext({
        spaceName: activeView?.name ?? null,
        widgetLabel,
        maximized: Boolean(soloTileId && soloTileId === focusedTileId),
        zen: Boolean(zenTileId && zenTileId === focusedTileId),
        tracePane: widgetLabel === "Trace" ? traceOperatorPane : null,
      }),
    [
      activeView?.name,
      focusedTileId,
      soloTileId,
      traceOperatorPane,
      widgetLabel,
      zenTileId,
    ],
  )

  const paneSurface = widgetLabel === "Trace" ? traceOperatorPane : null

  const filtered = useMemo(
    () => filterShortcutRegistry(SHORTCUT_REGISTRY, query, paneSurface),
    [paneSurface, query],
  )

  const paneItems = filtered.filter((item) => item.category === "pane")
  const shellItems = filtered.filter(
    (item) => item.category === "workspace" || item.category === "global",
  )

  useEffect(() => {
    if (!open) return
    setQuery("")
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  function close() {
    setOpen(false)
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (query.length > 0) {
        setQuery("")
        return
      }
      close()
    }
  }

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      if (query.length > 0) {
        setQuery("")
        return
      }
      setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open, query, setOpen])

  if (!open) return null

  return (
    <div className="ops-sheet-overlay" role="presentation" onClick={close}>
      <div
        className="ops-sheet ops-sheet--board"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ops-sheet__header">
          <Search size={16} strokeWidth={1.75} className="ops-sheet__search-icon" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            className="ops-sheet__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search keymaps or commands…"
            aria-label="Search keymaps"
            autoComplete="off"
            spellCheck={false}
          />
        </header>

        <div className="ops-sheet__context">
          <span>
            Active Context:{" "}
            <span className="ops-sheet__context-name">{context.title}</span>
          </span>
          {context.override ? (
            <span className="ops-sheet__context-badge">Pane override</span>
          ) : (
            <span className="ops-sheet__context-badge ops-sheet__context-badge--quiet">
              Shell
            </span>
          )}
        </div>

        <div className="ops-sheet__grid">
          <section className="ops-sheet__col">
            <h3 className="ops-sheet__col-title">Pane navigation</h3>
            {paneItems.length === 0 ? (
              <p className="ops-sheet__col-empty">No matches</p>
            ) : (
              <ul className="ops-sheet__rows">
                {paneItems.map((item) => (
                  <ShortcutRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
          <section className="ops-sheet__col">
            <h3 className="ops-sheet__col-title">Workspace & shell</h3>
            {shellItems.length === 0 ? (
              <p className="ops-sheet__col-empty">No matches</p>
            ) : (
              <ul className="ops-sheet__rows">
                {shellItems.map((item) => (
                  <ShortcutRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="ops-sheet__footer">
          <ComposerKbdFooter hints={keymapFooterHints(Boolean(query))} />
        </footer>
      </div>
    </div>
  )
}

function keymapFooterHints(hasQuery: boolean): readonly KbdHint[] {
  return [{ keys: ["Esc"], label: hasQuery ? "clear" : "dismiss" }]
}

function ShortcutRow({ item }: { item: ShortcutItem }) {
  const keys = resolveKeyCaptions(item.keys)
  return (
    <li className="ops-sheet__row">
      <span className="ops-sheet__label">{item.label}</span>
      <span className="ops-sheet__keys">
        {keys.map((key) => (
          <kbd key={`${item.id}:${key}`} className="composer-kbd">
            {key}
          </kbd>
        ))}
      </span>
    </li>
  )
}
