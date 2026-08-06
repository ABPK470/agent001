/**
 * Summon (⌘K) — same ops-sheet chrome as Keymap (?):
 * search · [1–3] tabs · Active Context · zero-scroll 2-col grid · Esc ladder.
 *
 * Enter peeks / goes / focuses; ⌘Enter keeps a surface in the current Space.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { Search } from "lucide-react"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { resolveKeymapActiveContext } from "../../lib/keymap"
import {
  resolveSummonBundleOpen,
  resolveSummonSpaceEnter,
  resolveSummonWidgetEnter,
  resolveSummonWidgetKeep,
  type SummonOpenAction,
} from "../../lib/summon-resolve"
import { getWidgetDefinition } from "./widget-definitions"
import {
  filterSummonItems,
  listSummonItems,
  summonActionPreview,
  summonItemKey,
  type SummonItem,
} from "./summon-items"
import {
  filterSummonByTab,
  nextSummonTab,
  orderSummonForNav,
  summonActionKeys,
  summonTabFromDigit,
  SUMMON_TABS,
  type SummonTab,
} from "./summon-tabs"

export function SummonPalette() {
  const summonOpen = useStore((s) => s.summonOpen)
  const setSummonOpen = useStore((s) => s.setSummonOpen)
  const openModalWidget = useStore((s) => s.openModalWidget)
  const activeRunId = useStore((s) => s.activeRunId)
  const requestWorkspaceShell = useStore((s) => s.requestWorkspaceShell)
  const traceOperatorPane = useStore((s) => s.traceOperatorPane)

  const callSpace = useLayoutStore((s) => s.callSpace)
  const ensureWidgets = useLayoutStore((s) => s.ensureWidgets)
  const focusWidgetType = useLayoutStore((s) => s.focusWidgetType)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenTileId = useLayoutStore((s) => s.zenTileId)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)

  const [query, setQuery] = useState("")
  const [tab, setTab] = useState<SummonTab>("all")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const catalog = useMemo(() => listSummonItems(), [])
  const matched = useMemo(() => filterSummonItems(query, catalog), [catalog, query])
  const filtered = useMemo(() => filterSummonByTab(matched, tab), [matched, tab])
  const navItems = useMemo(() => orderSummonForNav(filtered), [filtered])

  const goItems = filtered.filter(
    (item) => item.kind === "space" || item.kind === "bundle",
  )
  const surfaceItems = filtered.filter((item) => item.kind === "widget")

  const activeView = views.find((view) => view.id === activeViewId)
  const focusedTile = focusedTileId
    ? activeView?.tiles.find((tile) => tile.id === focusedTileId)
    : undefined
  const widgetLabel = focusedTile
    ? getWidgetDefinition(focusedTile.type).label
    : null

  const presentTypes = useMemo(() => {
    const set = new Set<string>()
    for (const tile of activeView?.tiles ?? []) set.add(tile.type)
    return set
  }, [activeView])

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

  useEffect(() => {
    if (!summonOpen) return
    ensureProductSpaces()
    setQuery("")
    setTab("all")
    setSelected(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [ensureProductSpaces, summonOpen])

  useEffect(() => {
    setSelected(0)
  }, [query, tab])

  useEffect(() => {
    if (!summonOpen) return
    const shell = document.querySelector(".app-shell-view")
    if (!(shell instanceof HTMLElement)) return
    shell.setAttribute("inert", "")
    return () => shell.removeAttribute("inert")
  }, [summonOpen])

  // Keep selection in range when the filtered list shrinks.
  useEffect(() => {
    if (selected >= navItems.length) {
      setSelected(Math.max(0, navItems.length - 1))
    }
  }, [navItems.length, selected])

  const current = navItems[selected] ?? null
  const onSpace =
    current?.kind === "widget" ? presentTypes.has(current.type) : false
  const preview = summonActionPreview(current, {
    onSpace,
    spaceName: activeView?.name ?? null,
  })

  function dismiss() {
    setSummonOpen(false)
  }

  function runAction(action: SummonOpenAction) {
    if (action.type === "call-space") {
      requestWorkspaceShell()
      callSpace(action.spaceId)
      dismiss()
      return
    }
    if (action.type === "peek-widget") {
      openModalWidget(action.widgetType, activeRunId ?? undefined)
      dismiss()
      return
    }
    if (action.type === "focus-tile") {
      requestWorkspaceShell()
      focusWidgetType(action.widgetType)
      dismiss()
      return
    }
    if (action.type === "open-bundle") {
      requestWorkspaceShell()
      callSpace(action.spaceId)
      ensureWidgets(action.spaceId, action.ensureWidgets)
      focusWidgetType(action.focusType)
      dismiss()
      return
    }
    requestWorkspaceShell()
    ensureWidgets(activeViewId, action.widgets)
    focusWidgetType(action.focusType)
    dismiss()
  }

  function onEnter(item: SummonItem, keep: boolean) {
    if (item.kind === "space") {
      runAction(resolveSummonSpaceEnter(item.id))
      return
    }
    if (item.kind === "bundle") {
      const action = resolveSummonBundleOpen(item.id)
      if (action) runAction(action)
      return
    }
    if (keep) {
      runAction(resolveSummonWidgetKeep(item.type))
      return
    }
    runAction(resolveSummonWidgetEnter(item.type, presentTypes.has(item.type)))
  }

  function moveSelection(delta: number) {
    if (navItems.length === 0) return
    setSelected((i) => {
      const next = i + delta
      if (next < 0) return 0
      if (next >= navItems.length) return navItems.length - 1
      return next
    })
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (query.length > 0) {
        setQuery("")
        return
      }
      dismiss()
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      setTab((currentTab) => nextSummonTab(currentTab, event.shiftKey ? -1 : 1))
      return
    }

    if (query.length === 0 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const next = summonTabFromDigit(event.key)
      if (next) {
        event.preventDefault()
        setTab(next)
        return
      }
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveSelection(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveSelection(-1)
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setSelected(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setSelected(Math.max(navItems.length - 1, 0))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (!current) return
      onEnter(current, event.metaKey || event.ctrlKey)
    }
  }

  useEffect(() => {
    if (!summonOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      if (query.length > 0) {
        setQuery("")
        return
      }
      setSummonOpen(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [summonOpen, query, setSummonOpen])

  if (!summonOpen) return null

  const showGo = tab === "all" || tab === "go"
  const showSurface = tab === "all" || tab === "surface"

  return (
    <div className="ops-sheet-overlay" role="presentation" onClick={dismiss}>
      <div
        className="ops-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Summon"
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
            placeholder="Search spaces, presets, or surfaces…"
            aria-label="Summon search"
            aria-controls="summon-list"
            aria-activedescendant={
              current ? `summon-option-${summonItemKey(current)}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ops-sheet__tabs" role="tablist" aria-label="Summon categories">
            {SUMMON_TABS.map((entry) => (
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
          <span className="ops-sheet__context-badge ops-sheet__context-badge--quiet">
            Keep → this Space
          </span>
        </div>

        <div className="ops-sheet__grid" id="summon-list" role="listbox" aria-label="Summon">
          {navItems.length === 0 ? (
            <div className="ops-sheet__empty">
              No matches for “{query.trim() || tab}”
            </div>
          ) : (
            <>
              {showGo && goItems.length > 0 ? (
                <section className="ops-sheet__col">
                  <h3 className="ops-sheet__col-title">Go to Space · Preset</h3>
                  <ul className="ops-sheet__rows">
                    {goItems.map((item) => (
                      <SummonRow
                        key={summonItemKey(item)}
                        item={item}
                        selected={item === current}
                        present={false}
                        currentSpace={item.kind === "space" && item.id === activeViewId}
                        onHover={() => setSelected(navItems.indexOf(item))}
                        onOpen={() => onEnter(item, false)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}
              {showSurface && surfaceItems.length > 0 ? (
                <section className="ops-sheet__col">
                  <h3 className="ops-sheet__col-title">Summon surface</h3>
                  <ul className="ops-sheet__rows">
                    {surfaceItems.map((item) => {
                      const present = presentTypes.has(item.type)
                      return (
                        <SummonRow
                          key={summonItemKey(item)}
                          item={item}
                          selected={item === current}
                          present={present}
                          currentSpace={false}
                          onHover={() => setSelected(navItems.indexOf(item))}
                          onOpen={() => onEnter(item, false)}
                        />
                      )
                    })}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>

        <footer className="ops-sheet__footer">
          <div className="ops-sheet__footer-hints">
            <span>
              <kbd>↵</kbd> {preview.primary}
            </span>
            <span>
              <kbd>⌘</kbd>
              <kbd>↵</kbd> keep
            </span>
            <span>
              <kbd>1–3</kbd> categories
            </span>
            <span>
              <kbd>Tab</kbd> cycle
            </span>
            <span>
              <kbd>Esc</kbd> {query ? "clear" : "dismiss"}
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}

function SummonRow({
  item,
  selected,
  present,
  currentSpace,
  onHover,
  onOpen,
}: {
  item: SummonItem
  selected: boolean
  present: boolean
  currentSpace: boolean
  onHover: () => void
  onOpen: () => void
}) {
  const keys = summonActionKeys(item, { onSpace: present })
  const label = currentSpace
    ? `${item.name} · current`
    : present
      ? `${item.name} · here`
      : item.name

  return (
    <li>
      <button
        id={`summon-option-${summonItemKey(item)}`}
        type="button"
        role="option"
        aria-selected={selected}
        className={`ops-sheet__row ops-sheet__row--interactive${selected ? " is-selected" : ""}`}
        onMouseEnter={onHover}
        onClick={onOpen}
      >
        <span className="ops-sheet__label" title={item.desc}>
          {label}
        </span>
        <span className="ops-sheet__keys">
          {keys.map((key) => (
            <kbd key={`${summonItemKey(item)}:${key}`}>{key}</kbd>
          ))}
        </span>
      </button>
    </li>
  )
}
