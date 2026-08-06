/**
 * Summon (⌘K) — fixed two-column ops board:
 * search · Active Context · Go | Surface · Esc ladder.
 *
 * ↑↓ move in a column · ←→ jump columns · Enter peeks/goes/focuses · ⌘Enter keeps.
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
import { MOD, resolveKeymapActiveContext, type KbdHint } from "../../lib/keymap"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
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
  moveSummonSelection,
  orderSummonForNav,
  partitionSummonColumns,
  summonActionKeys,
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
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const catalog = useMemo(() => listSummonItems(), [])
  const matched = useMemo(() => filterSummonItems(query, catalog), [catalog, query])
  const columns = useMemo(() => partitionSummonColumns(matched), [matched])
  const navItems = useMemo(() => orderSummonForNav(matched), [matched])

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

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelected((i) => moveSummonSelection(i, columns, "down"))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelected((i) => moveSummonSelection(i, columns, "up"))
      return
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      setSelected((i) => moveSummonSelection(i, columns, "right"))
      return
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      setSelected((i) => moveSummonSelection(i, columns, "left"))
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

  return (
    <div className="ops-sheet-overlay" role="presentation" onClick={dismiss}>
      <div
        className="ops-sheet ops-sheet--board"
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
          <section className="ops-sheet__col">
            <h3 className="ops-sheet__col-title">Go to Space · Preset</h3>
            {columns.go.length === 0 ? (
              <p className="ops-sheet__col-empty">No matches</p>
            ) : (
              <ul className="ops-sheet__rows">
                {columns.go.map((item) => (
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
            )}
          </section>
          <section className="ops-sheet__col">
            <h3 className="ops-sheet__col-title">Summon surface</h3>
            {columns.surface.length === 0 ? (
              <p className="ops-sheet__col-empty">No matches</p>
            ) : (
              <ul className="ops-sheet__rows">
                {columns.surface.map((item) => {
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
            )}
          </section>
        </div>

        <footer className="ops-sheet__footer">
          <ComposerKbdFooter hints={summonFooterHints(preview.primary, Boolean(query))} />
        </footer>
      </div>
    </div>
  )
}

function summonFooterHints(primary: string, hasQuery: boolean): readonly KbdHint[] {
  return [
    { keys: ["↵"], label: primary },
    { keys: [MOD, "↵"], label: "keep" },
    { keys: ["↑", "↓"], label: "move" },
    { keys: ["←", "→"], label: "column" },
    { keys: ["Esc"], label: hasQuery ? "clear" : "dismiss" },
  ]
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
            <kbd key={`${summonItemKey(item)}:${key}`} className="composer-kbd">
              {key}
            </kbd>
          ))}
        </span>
      </button>
    </li>
  )
}
