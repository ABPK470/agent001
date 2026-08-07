/**
 * Summon (⌘K) — command list + spatial blueprint.
 *
 * Left: All / Spaces / Surfaces · ↑↓ move · Tab filter
 * Right: live Space blueprint (1–9 tile) or surface card
 * Enter keeps/goes · ⌘Enter peeks (Summon stays open) · Esc peels peek → clear → dismiss
 */

import { Search } from "lucide-react"
import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { resolveKeymapActiveContext } from "../../lib/keymap"
import {
    resolveSummonBlueprintTileEnter,
    resolveSummonBundleOpen,
    resolveSummonSpaceEnter,
    resolveSummonWidgetEnter,
    resolveSummonWidgetPeek,
    type SummonOpenAction,
} from "../../lib/summon-resolve"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import { resolveKeyCaptions } from "../../lib/keymap"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
import { summonContextHints, summonFooterHints } from "./summon-footer"
import {
    filterSummonItems,
    listSummonItems,
    summonActionPreview,
    summonItemIcon,
    summonItemKey,
    type SummonItem,
} from "./summon-items"
import { resolveSummonPreview } from "./summon-preview"
import { SummonSpatialPreview } from "./SummonSpatialPreview"
import {
    cycleSummonFilter,
    filterSummonByMode,
    moveSummonListSelection,
    shouldSummonBlueprintDigit,
    shouldSummonFilterArrow,
    SUMMON_FILTER_LABEL,
    SUMMON_FILTER_MODES,
    summonActionKeys,
    summonListSections,
    type SummonFilterMode,
} from "./summon-tabs"
import { getWidgetDefinition } from "./widget-definitions"

export function SummonPalette() {
  const summonOpen = useStore((s) => s.summonOpen)
  const setSummonOpen = useStore((s) => s.setSummonOpen)
  const openModalWidget = useStore((s) => s.openModalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const modalWidget = useStore((s) => s.modalWidget)
  const activeRunId = useStore((s) => s.activeRunId)
  const requestWorkspaceShell = useStore((s) => s.requestWorkspaceShell)
  const traceOperatorPane = useStore((s) => s.traceOperatorPane)

  const callSpace = useLayoutStore((s) => s.callSpace)
  const callSpaceFocusPick = useLayoutStore((s) => s.callSpaceFocusPick)
  const ensureWidgets = useLayoutStore((s) => s.ensureWidgets)
  const openSpacePreset = useLayoutStore((s) => s.openSpacePreset)
  const focusWidgetType = useLayoutStore((s) => s.focusWidgetType)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenTileId = useLayoutStore((s) => s.zenTileId)
  const viewportRows = useLayoutStore((s) => s.viewportRows)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)

  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [filterMode, setFilterMode] = useState<SummonFilterMode>("all")
  const inputRef = useRef<HTMLInputElement>(null)

  const catalog = useMemo(
    () => listSummonItems({ views, viewportRows }),
    [views, viewportRows],
  )
  const searched = useMemo(() => filterSummonItems(query, catalog), [catalog, query])
  const navItems = useMemo(
    () => filterSummonByMode(searched, filterMode),
    [searched, filterMode],
  )
  const sections = useMemo(() => summonListSections(navItems), [navItems])

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
    setFilterMode("all")
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [ensureProductSpaces, summonOpen])

  // Peek owns the operator surface — blur Summon and make the board inert.
  useEffect(() => {
    if (!summonOpen || !modalWidget) return
    inputRef.current?.blur()
    const sheet = document.querySelector(".ops-sheet--summon")
    if (!(sheet instanceof HTMLElement)) return
    sheet.setAttribute("inert", "")
    return () => sheet.removeAttribute("inert")
  }, [summonOpen, modalWidget])

  useEffect(() => {
    setSelected(0)
  }, [query, filterMode])

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

  useEffect(() => {
    if (!summonOpen) return
    const current = navItems[selected]
    if (!current) return
    const el = document.getElementById(`summon-option-${summonItemKey(current)}`)
    el?.scrollIntoView({ block: "nearest" })
  }, [navItems, selected, summonOpen])

  useEffect(() => {
    if (!summonOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      if (modalWidget) {
        closeModalWidget()
        return
      }
      if (query.length > 0) {
        setQuery("")
        return
      }
      setSummonOpen(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [summonOpen, query, setSummonOpen, modalWidget, closeModalWidget])

  const current = navItems[selected] ?? null
  const onSpace =
    current?.kind === "widget" ? presentTypes.has(current.type) : false
  const actionPreview = summonActionPreview(current, {
    onSpace,
    spaceName: activeView?.name ?? null,
  })
  const contextHints = summonContextHints(current)
  const previewModel = useMemo(
    () =>
      resolveSummonPreview(current, views, {
        presentTypes,
        viewportRows,
      }),
    [current, presentTypes, views, viewportRows],
  )
  const pickableCount =
    previewModel.mode === "blueprint" ? previewModel.pickable.length : 0

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
    if (action.type === "call-space-focus-pick") {
      requestWorkspaceShell()
      callSpaceFocusPick(action.spaceId, action.pickIndex)
      dismiss()
      return
    }
    if (action.type === "peek-widget") {
      // Peek stacks above Summon — keep the board open for Esc ladder.
      openModalWidget(action.widgetType, activeRunId ?? undefined)
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
      openSpacePreset(action.spaceId, action.focusType, action.pickIndex)
      dismiss()
      return
    }
    requestWorkspaceShell()
    ensureWidgets(activeViewId, action.widgets)
    focusWidgetType(action.focusType)
    dismiss()
  }

  function onEnter(item: SummonItem, modEnter: boolean) {
    if (item.kind === "space") {
      runAction(resolveSummonSpaceEnter(item.id))
      return
    }
    if (item.kind === "bundle") {
      const action = resolveSummonBundleOpen(item.id)
      if (action) runAction(action)
      return
    }
    if (modEnter) {
      runAction(resolveSummonWidgetPeek(item.type))
      return
    }
    runAction(resolveSummonWidgetEnter(item.type, presentTypes.has(item.type)))
  }

  function onBlueprintTile(tileId: string) {
    if (!current || (current.kind !== "space" && current.kind !== "bundle")) return
    if (previewModel.mode !== "blueprint") return
    const pickIndex = previewModel.pickable.findIndex((p) => p.tileId === tileId)
    if (pickIndex < 0) return
    const action = resolveSummonBlueprintTileEnter(current, pickIndex)
    if (action) runAction(action)
  }

  function peelEsc() {
    if (modalWidget) {
      closeModalWidget()
      return
    }
    if (query.length > 0) {
      setQuery("")
      return
    }
    dismiss()
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      peelEsc()
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      setFilterMode((mode) =>
        cycleSummonFilter(mode, event.shiftKey ? "prev" : "next"),
      )
      return
    }

    const filterDir = shouldSummonFilterArrow(event, query)
    if (filterDir) {
      event.preventDefault()
      setFilterMode((mode) => cycleSummonFilter(mode, filterDir))
      return
    }

    const digitPick = shouldSummonBlueprintDigit(event, query, pickableCount)
    if (digitPick != null && current
      && (current.kind === "space" || current.kind === "bundle")
    ) {
      event.preventDefault()
      const action = resolveSummonBlueprintTileEnter(current, digitPick)
      if (action) runAction(action)
      return
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelected((i) => moveSummonListSelection(i, navItems.length, "down"))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelected((i) => moveSummonListSelection(i, navItems.length, "up"))
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

  if (!summonOpen) return null

  function keepSearchFocus(event: { preventDefault: () => void }) {
    // Rows/tabs are mouse targets only — keyboard focus stays in the search input
    // (aria-activedescendant). Prevents the native blue focus ring on list buttons.
    event.preventDefault()
  }

  function setFilterAndRefocus(mode: SummonFilterMode) {
    setFilterMode(mode)
    inputRef.current?.focus()
  }

  return (
    <div
      className="ops-sheet-overlay ops-sheet-overlay--summon"
      role="presentation"
      onClick={dismiss}
    >
      <div
        className="ops-sheet ops-sheet--summon"
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
          <div className="ops-sheet__header-context">
            <span>
              Active:{" "}
              <span className="ops-sheet__header-context-name">{context.title}</span>
            </span>
            {contextHints ? (
              <span className="ops-sheet__context-badge" aria-hidden>
                {contextHints.map((hint) => {
                  const keys = resolveKeyCaptions(hint.keys)
                  return (
                    <span
                      key={`${hint.label}:${keys.join("+")}`}
                      className="composer-kbd-footer__hint"
                    >
                      {keys.map((key) => (
                        <kbd key={key} className="composer-kbd">
                          {key}
                        </kbd>
                      ))}
                      <span>{hint.label}</span>
                    </span>
                  )
                })}
              </span>
            ) : null}
          </div>
        </header>

        <div className="ops-sheet__body">
          <div className="ops-sheet__list">
            <div
              className="ops-sheet__tabs"
              role="tablist"
              aria-label="Summon filter"
            >
              {SUMMON_FILTER_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  tabIndex={-1}
                  aria-selected={filterMode === mode}
                  className={[
                    "ops-sheet__tab",
                    filterMode === mode ? "is-active" : "",
                  ].filter(Boolean).join(" ")}
                  onMouseDown={keepSearchFocus}
                  onClick={() => setFilterAndRefocus(mode)}
                >
                  {SUMMON_FILTER_LABEL[mode]}
                </button>
              ))}
              <span className="ops-sheet__tabs-hint" aria-hidden>
                <kbd className="composer-kbd">←</kbd>
                <kbd className="composer-kbd">→</kbd>
                <span>filter</span>
              </span>
            </div>

            <div
              id="summon-list"
              className="ops-sheet__list-scroll"
              role="listbox"
              aria-label="Summon"
            >
              {navItems.length === 0 ? (
                <p className="ops-sheet__col-empty">No matches</p>
              ) : (
                sections.map((section) => (
                  <section key={section.id} className="ops-sheet__section">
                    <h3 className="ops-sheet__col-title">{section.title}</h3>
                    <ul className="ops-sheet__rows">
                      {section.items.map((item) => {
                        const present =
                          item.kind === "widget"
                            ? presentTypes.has(item.type)
                            : false
                        return (
                          <SummonRow
                            key={summonItemKey(item)}
                            item={item}
                            selected={item === current}
                            present={present}
                            currentSpace={
                              item.kind === "space" && item.id === activeViewId
                            }
                            onHover={() => setSelected(navItems.indexOf(item))}
                            onOpen={() => onEnter(item, false)}
                          />
                        )
                      })}
                    </ul>
                  </section>
                ))
              )}
            </div>
          </div>

          <div className="ops-sheet__detail" aria-live="polite">
            <SummonSpatialPreview
              model={previewModel}
              onSelectTile={
                current?.kind === "space" || current?.kind === "bundle"
                  ? onBlueprintTile
                  : undefined
              }
            />
          </div>
        </div>

        <footer className="ops-sheet__footer">
          <ComposerKbdFooter
            hints={summonFooterHints(current, {
              primary: actionPreview.primary,
              hasQuery: Boolean(query),
              pickableCount,
            })}
          />
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
  const isPreset = item.kind === "bundle"
  const Icon = summonItemIcon(item)
  const statusPill = currentSpace ? "Current" : present ? "Active" : null

  return (
    <li>
      <button
        id={`summon-option-${summonItemKey(item)}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-label={
          statusPill ? `${item.name}, ${statusPill}` : item.name
        }
        className={[
          "ops-sheet__row",
          "ops-sheet__row--interactive",
          selected ? "is-selected" : "",
          isPreset ? "ops-sheet__row--preset" : "",
        ].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={onHover}
        onClick={onOpen}
      >
        <span className="ops-sheet__label">
          <Icon size={14} className="ops-sheet__row-icon" aria-hidden />
          <span className="ops-sheet__label-text">{item.name}</span>
          {isPreset ? <span className="ops-sheet__preset-mark">Reset</span> : null}
        </span>
        <span className="ops-sheet__row-trail">
          {statusPill ? (
            <span className="ops-sheet__status-pill">{statusPill}</span>
          ) : null}
          <span className="ops-sheet__keys" aria-hidden>
            {keys.map((key) => (
              <kbd key={`${summonItemKey(item)}:${key}`} className="composer-kbd">
                {key}
              </kbd>
            ))}
          </span>
        </span>
      </button>
    </li>
  )
}
