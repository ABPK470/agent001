/**
 * Keymap sheet (?) — keyboard-first, zero-scroll command & shortcut modal.
 *
 * Filter + category tabs trim density; Esc clears filter then closes.
 * Active Context reflects Space · focused widget · Trace pane.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Search } from "lucide-react"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import {
  KEYMAP_TABS,
  filterShortcutRegistry,
  keymapTabFromDigit,
  nextKeymapTab,
  resolveKeymapActiveContext,
  SHORTCUT_REGISTRY,
  type KeymapTab,
  type ShortcutItem,
} from "../../lib/keymap"
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
  const [tab, setTab] = useState<KeymapTab>("all")
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

  const filtered = useMemo(
    () => filterShortcutRegistry(SHORTCUT_REGISTRY, query, tab),
    [query, tab],
  )

  const paneItems = filtered.filter((item) => item.category === "pane")
  const shellItems = filtered.filter(
    (item) => item.category === "workspace" || item.category === "global",
  )

  useEffect(() => {
    if (!open) return
    setQuery("")
    setTab("all")
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
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      setTab((current) => nextKeymapTab(current, event.shiftKey ? -1 : 1))
      return
    }

    if (query.length === 0 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const next = keymapTabFromDigit(event.key)
      if (next) {
        event.preventDefault()
        setTab(next)
      }
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

  const showPaneColumn = tab === "all" || tab === "pane"
  const showShellColumn = tab === "all" || tab === "shell"

  return (
    <div className="ops-sheet-overlay" role="presentation" onClick={close}>
      <div
        className="ops-sheet"
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
          <div className="ops-sheet__tabs" role="tablist" aria-label="Keymap categories">
            {KEYMAP_TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={`ops-sheet__tab${tab === entry.id ? " is-active" : ""}`}
                onClick={() => setTab(entry.id)}
              >
                <span className="ops-sheet__tab-num">[{entry.num}]</span>
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
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
          {filtered.length === 0 ? (
            <div className="ops-sheet__empty">
              No keymaps matching “{query.trim() || tab}”
            </div>
          ) : (
            <>
              {showPaneColumn && paneItems.length > 0 ? (
                <section className="ops-sheet__col">
                  <h3 className="ops-sheet__col-title">Pane navigation</h3>
                  <ul className="ops-sheet__rows">
                    {paneItems.map((item) => (
                      <ShortcutRow key={item.id} item={item} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {showShellColumn && shellItems.length > 0 ? (
                <section className="ops-sheet__col">
                  <h3 className="ops-sheet__col-title">Workspace & shell</h3>
                  <ul className="ops-sheet__rows">
                    {shellItems.map((item) => (
                      <ShortcutRow key={item.id} item={item} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>

        <footer className="ops-sheet__footer">
          <div className="ops-sheet__footer-hints">
            <span>
              <kbd>1–3</kbd> categories
            </span>
            <span>
              <kbd>Tab</kbd> cycle
            </span>
            <span>
              <kbd>Esc</kbd> {query ? "clear" : "dismiss"}
            </span>
            <span>Type to filter</span>
          </div>
        </footer>
      </div>
    </div>
  )
}

function ShortcutRow({ item }: { item: ShortcutItem }) {
  return (
    <li className="ops-sheet__row">
      <span className="ops-sheet__label">{item.label}</span>
      <span className="ops-sheet__keys">
        {item.keys.map((key) => (
          <kbd key={`${item.id}:${key}`}>{key}</kbd>
        ))}
      </span>
    </li>
  )
}
