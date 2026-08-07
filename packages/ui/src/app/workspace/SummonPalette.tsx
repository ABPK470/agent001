/**
 * Summon (⌘K) — keyboard-first dispatch board.
 *
 * Cursor (↑↓) ≠ bag (Space / click on surfaces — checkbox toggle).
 * Bag: absent → keep, Active → remove; Enter applies.
 * Spaces list includes product Spaces + custom layouts.
 * ⌘Enter or right-click peeks the cursor surface (bag must be empty).
 * Esc: peel peek → clear bag → clear query → dismiss.
 *
 * Keyboard ownership: one window capture owns all Summon commands while open
 * (nav, filter, land, peek). Search input only types — mouse must not strand keys.
 */

import { Search, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { resolveKeymapActiveContext } from "../../lib/keymap"
import {
  partitionSummonBag,
  resolveSummonLand,
  toggleSummonPick,
} from "../../lib/summon-pick"
import {
  resolveSummonBlueprintTileEnter,
  resolveSummonBundleOpen,
  resolveSummonSpaceEnter,
  resolveSummonWidgetPeek,
  type SummonOpenAction,
} from "../../lib/summon-resolve"
import type { WidgetType } from "../../types"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import { resolveKeyCaptions } from "../../lib/keymap"
import { ComposerKbdFooter } from "../../widgets/chat/ComposerKbdFooter"
import {
  summonApplyButtonLabel,
  summonContextHints,
  summonFooterHints,
} from "./summon-footer"
import {
  filterSummonItems,
  listSummonItems,
  summonActionPreview,
  summonItemIcon,
  summonSpaceRemovable,
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
  const goView = useLayoutStore((s) => s.goView)
  const goViewFocusPick = useLayoutStore((s) => s.goViewFocusPick)
  const ensureWidgets = useLayoutStore((s) => s.ensureWidgets)
  const removeWidgetsByType = useLayoutStore((s) => s.removeWidgetsByType)
  const openSpacePreset = useLayoutStore((s) => s.openSpacePreset)
  const focusWidgetType = useLayoutStore((s) => s.focusWidgetType)
  const zenKeepWidget = useLayoutStore((s) => s.zenKeepWidget)
  const removeView = useLayoutStore((s) => s.removeView)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenActive = useLayoutStore((s) => s.zenActive)
  const zenSet = useLayoutStore((s) => s.zenSet)
  const zenExtraTiles = useLayoutStore((s) => s.zenExtraTiles)
  const viewportRows = useLayoutStore((s) => s.viewportRows)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)

  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [filterMode, setFilterMode] = useState<SummonFilterMode>("all")
  const [pickedTypes, setPickedTypes] = useState<Set<WidgetType>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  // Window capture reads latest bag/cursor/nav — never strand keys on input focus.
  const pickedRef = useRef(pickedTypes)
  const selectedRef = useRef(selected)
  const queryRef = useRef(query)
  const navItemsRef = useRef<SummonItem[]>([])
  const presentRef = useRef<Set<string>>(new Set())
  const pickableCountRef = useRef(0)
  const pickedCountRef = useRef(0)
  const modalWidgetRef = useRef(modalWidget)
  const landRef = useRef<(modEnter: boolean) => void>(() => {})
  const toggleRef = useRef<(type: WidgetType) => void>(() => {})
  const runActionRef = useRef<(action: SummonOpenAction) => void>(() => {})
  const peelEscRef = useRef<() => void>(() => {})
  const removeRemovableRef = useRef<() => void>(() => {})

  const consoleIsAdmin = useLayoutStore((s) => s.consoleIsAdmin)
  const catalog = useMemo(
    () =>
      listSummonItems({
        views,
        viewportRows,
        isAdmin: consoleIsAdmin,
        zenActive,
      }),
    [views, viewportRows, consoleIsAdmin, zenActive],
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
      ?? zenExtraTiles.find((tile) => tile.id === focusedTileId)
    : undefined
  const widgetLabel = focusedTile
    ? getWidgetDefinition(focusedTile.type).label
    : null

  const presentTypes = useMemo(() => {
    const set = new Set<string>()
    if (zenActive) {
      const byId = new Map<string, string>()
      for (const tile of activeView?.tiles ?? []) byId.set(tile.id, tile.type)
      for (const tile of zenExtraTiles) byId.set(tile.id, tile.type)
      for (const id of zenSet) {
        const type = byId.get(id)
        if (type) set.add(type)
      }
      return set
    }
    for (const tile of activeView?.tiles ?? []) set.add(tile.type)
    return set
  }, [activeView, zenActive, zenExtraTiles, zenSet])

  const context = useMemo(
    () =>
      resolveKeymapActiveContext({
        spaceName: activeView?.name ?? null,
        widgetLabel,
        maximized: Boolean(soloTileId && soloTileId === focusedTileId),
        zen: Boolean(
          zenActive && focusedTileId && zenSet.includes(focusedTileId),
        ),
        tracePane: widgetLabel === "Trace" ? traceOperatorPane : null,
      }),
    [
      activeView?.name,
      focusedTileId,
      soloTileId,
      traceOperatorPane,
      widgetLabel,
      zenActive,
      zenSet,
    ],
  )

  const current = navItems[selected] ?? null
  const bagPartition = useMemo(
    () => partitionSummonBag([...pickedTypes], presentTypes),
    [pickedTypes, presentTypes],
  )
  const keepCount = bagPartition.keep.length
  const removeCount = bagPartition.remove.length
  const pickedCount = keepCount + removeCount
  const onSpace =
    current?.kind === "widget" ? presentTypes.has(current.type) : false
  const actionPreview = summonActionPreview(current, {
    onSpace,
    spaceName: activeView?.name ?? null,
  })
  const contextHints = summonContextHints(current, { keepCount, removeCount })
  const previewModel = useMemo(
    () =>
      resolveSummonPreview(current, views, {
        presentTypes,
        viewportRows,
        pickedCount,
        isAdmin: consoleIsAdmin,
      }),
    [consoleIsAdmin, current, presentTypes, views, viewportRows, pickedCount],
  )
  const pickableCount =
    previewModel.mode === "blueprint" ? previewModel.pickable.length : 0

  function dismiss() {
    setSummonOpen(false)
  }

  function togglePick(type: WidgetType) {
    setPickedTypes((prev) => toggleSummonPick(prev, type))
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
    if (action.type === "go-view") {
      requestWorkspaceShell()
      goView(action.viewId)
      dismiss()
      return
    }
    if (action.type === "go-view-focus-pick") {
      requestWorkspaceShell()
      goViewFocusPick(action.viewId, action.pickIndex)
      dismiss()
      return
    }
    if (action.type === "peek-widget") {
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
    if (action.type === "apply-widgets") {
      requestWorkspaceShell()
      if (zenActive) {
        for (const type of action.keep) zenKeepWidget(type)
        if (action.focusType) focusWidgetType(action.focusType)
        setPickedTypes(new Set())
        dismiss()
        return
      }
      if (action.remove.length > 0) {
        removeWidgetsByType(activeViewId, action.remove)
      }
      if (action.keep.length > 0) {
        ensureWidgets(activeViewId, action.keep)
      }
      if (action.focusType) focusWidgetType(action.focusType)
      setPickedTypes(new Set())
      dismiss()
      return
    }
    requestWorkspaceShell()
    if (zenActive) {
      for (const type of action.widgets) zenKeepWidget(type)
      if (action.focusType) focusWidgetType(action.focusType)
      setPickedTypes(new Set())
      dismiss()
      return
    }
    ensureWidgets(activeViewId, action.widgets)
    focusWidgetType(action.focusType)
    setPickedTypes(new Set())
    dismiss()
  }

  /** Land bag or cursor — single commit path for Enter / Keep button / click. */
  function land(modEnter: boolean) {
    const bag = [...pickedRef.current]
    const cursor = navItemsRef.current[selectedRef.current] ?? null
    const present = presentRef.current

    if (bag.length > 0) {
      const action = resolveSummonLand({
        bag,
        presentTypes: present,
        cursorType: cursor?.kind === "widget" ? cursor.type : undefined,
        modEnter: false,
      })
      if (action) runAction(action)
      return
    }

    if (!cursor) return

    if (cursor.kind === "space") {
      runAction(resolveSummonSpaceEnter(cursor.id))
      return
    }
    if (cursor.kind === "bundle") {
      const action = resolveSummonBundleOpen(cursor.id)
      if (action) runAction(action)
      return
    }

    const action = resolveSummonLand({
      bag: [],
      presentTypes: present,
      cursorType: cursor.type,
      cursorPresent: present.has(cursor.type),
      modEnter,
    })
    if (action) runAction(action)
  }

  function onRowActivate(item: SummonItem) {
    const index = navItems.indexOf(item)
    if (index >= 0) setSelected(index)

    if (item.kind === "widget") {
      // Left-click = checkbox stage (same as Space). Enter / Keep lands the bag.
      togglePick(item.type)
      return
    }

    if (pickedCount > 0) return
    if (item.kind === "space") {
      runAction(resolveSummonSpaceEnter(item.id))
      return
    }
    const action = resolveSummonBundleOpen(item.id)
    if (action) runAction(action)
  }

  /** Mouse primary for peek — mirrors ⌘Enter without requiring the keyboard. */
  function onRowPeek(item: SummonItem) {
    if (item.kind !== "widget") return
    if (pickedCount > 0) return
    const index = navItems.indexOf(item)
    if (index >= 0) setSelected(index)
    runAction(resolveSummonWidgetPeek(item.type))
  }

  function onBlueprintTile(tileId: string) {
    if (!current || (current.kind !== "space" && current.kind !== "bundle")) return
    if (previewModel.mode !== "blueprint") return
    if (pickedCount > 0) return
    const pickIndex = previewModel.pickable.findIndex((p) => p.tileId === tileId)
    if (pickIndex < 0) return
    const action = resolveSummonBlueprintTileEnter(current, pickIndex)
    if (action) runAction(action)
  }

  function peelEsc() {
    if (modalWidgetRef.current) {
      closeModalWidget()
      return
    }
    if (pickedRef.current.size > 0) {
      setPickedTypes(new Set())
      return
    }
    if (queryRef.current.length > 0) {
      setQuery("")
      return
    }
    dismiss()
  }

  /** Delete DIY / Zen Space under the cursor — bag must be empty. */
  function removeRemovableSpace(item?: SummonItem) {
    if (pickedRef.current.size > 0) return
    const cursor = item ?? navItemsRef.current[selectedRef.current] ?? null
    if (!summonSpaceRemovable(cursor) || cursor?.kind !== "space") return
    const index = navItemsRef.current.findIndex((row) => row === cursor)
    removeView(cursor.id)
    // Selection clamps via effect after catalog rebuild.
    if (index >= 0) setSelected(index)
  }

  pickedRef.current = pickedTypes
  selectedRef.current = selected
  queryRef.current = query
  navItemsRef.current = navItems
  presentRef.current = presentTypes
  pickableCountRef.current = pickableCount
  pickedCountRef.current = pickedCount
  modalWidgetRef.current = modalWidget
  landRef.current = land
  toggleRef.current = togglePick
  runActionRef.current = runAction
  peelEscRef.current = peelEsc
  removeRemovableRef.current = () => removeRemovableSpace()

  useEffect(() => {
    if (!summonOpen) return
    ensureProductSpaces()
    setQuery("")
    setSelected(0)
    setFilterMode("all")
    setPickedTypes(new Set())
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [ensureProductSpaces, summonOpen])

  useEffect(() => {
    if (!summonOpen || !modalWidget) return
    inputRef.current?.blur()
    const sheet = document.querySelector(".ops-sheet--summon")
    if (!(sheet instanceof HTMLElement)) return
    sheet.setAttribute("inert", "")
    return () => {
      sheet.removeAttribute("inert")
      // Peek peels → restore Summon’s keyboard home (search).
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
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
    const item = navItems[selected]
    if (!item) return
    const el = document.getElementById(`summon-option-${summonItemKey(item)}`)
    el?.scrollIntoView({ block: "nearest" })
  }, [navItems, selected, summonOpen])

  /**
   * One capture owner for every Summon command while open.
   * Mouse (hover / click / peek) must not strand ↑↓←→ / ⌘↵ on input focus.
   */
  useEffect(() => {
    if (!summonOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (modalWidgetRef.current) {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          closeModalWidget()
        }
        return
      }

      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        peelEscRef.current()
        return
      }

      if (event.key === "Enter") {
        event.preventDefault()
        event.stopPropagation()
        landRef.current(event.metaKey || event.ctrlKey)
        return
      }

      // Browse mode: empty query → Space stages; never type a space into search.
      if (
        (event.key === " " || event.code === "Space")
        && queryRef.current.length === 0
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        const cursor = navItemsRef.current[selectedRef.current]
        if (cursor?.kind === "widget") toggleRef.current(cursor.type)
        return
      }

      if (event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        setFilterMode((mode) =>
          cycleSummonFilter(mode, event.shiftKey ? "prev" : "next"),
        )
        return
      }

      const filterDir = shouldSummonFilterArrow(event, queryRef.current)
      if (filterDir) {
        event.preventDefault()
        event.stopPropagation()
        setFilterMode((mode) => cycleSummonFilter(mode, filterDir))
        return
      }

      const digitPick = shouldSummonBlueprintDigit(
        event,
        queryRef.current,
        pickableCountRef.current,
      )
      if (digitPick != null && pickedCountRef.current === 0) {
        const cursor = navItemsRef.current[selectedRef.current]
        if (cursor && (cursor.kind === "space" || cursor.kind === "bundle")) {
          event.preventDefault()
          event.stopPropagation()
          const action = resolveSummonBlueprintTileEnter(cursor, digitPick)
          if (action) runActionRef.current(action)
          return
        }
      }

      const navLen = navItemsRef.current.length
      if (event.key === "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        setSelected((i) => moveSummonListSelection(i, navLen, "down"))
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        setSelected((i) => moveSummonListSelection(i, navLen, "up"))
        return
      }
      if (event.key === "Home") {
        event.preventDefault()
        event.stopPropagation()
        setSelected(0)
        return
      }
      if (event.key === "End") {
        event.preventDefault()
        event.stopPropagation()
        setSelected(Math.max(navLen - 1, 0))
        return
      }

      // ⌫ / Delete — remove DIY layout or Zen Space (never product Spaces).
      if (
        (event.key === "Backspace" || event.key === "Delete")
        && pickedCountRef.current === 0
        && queryRef.current.length === 0
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
      ) {
        const cursor = navItemsRef.current[selectedRef.current]
        if (summonSpaceRemovable(cursor)) {
          event.preventDefault()
          event.stopPropagation()
          removeRemovableRef.current()
        }
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [closeModalWidget, summonOpen])

  if (!summonOpen) return null

  function keepSearchFocus(event: { preventDefault: () => void }) {
    event.preventDefault()
  }

  function setFilterAndRefocus(mode: SummonFilterMode) {
    setFilterMode(mode)
    inputRef.current?.focus()
  }

  const primaryLabel =
    pickedCount > 0
      ? summonApplyButtonLabel({ keepCount, removeCount })
      : actionPreview.primary

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
          <Search size={17} strokeWidth={1.75} className="ops-sheet__search-icon" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            className="ops-sheet__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search spaces, presets, or surfaces…"
            aria-label="Summon search"
            aria-controls="summon-list"
            aria-activedescendant={
              current ? `summon-option-${summonItemKey(current)}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ops-sheet__header-context" aria-live="polite">
            <span className="ops-sheet__context-lead">
              <span className="ops-sheet__context-label">Active</span>
              <span className="ops-sheet__context-name">{context.title}</span>
            </span>
            <span className="ops-sheet__context-trail">
              {pickedCount > 0 ? (
                <span className="ops-sheet__pick-count">
                  {keepCount > 0 ? `+${keepCount}` : ""}
                  {keepCount > 0 && removeCount > 0 ? " · " : ""}
                  {removeCount > 0 ? `−${removeCount}` : ""}
                </span>
              ) : null}
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
            </span>
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
              aria-multiselectable="true"
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
                        const picked =
                          item.kind === "widget"
                            ? pickedTypes.has(item.type)
                            : false
                        return (
                          <SummonRow
                            key={summonItemKey(item)}
                            item={item}
                            selected={item === current}
                            present={present}
                            picked={picked}
                            staging={pickedCount > 0}
                            currentSpace={
                              item.kind === "space" && item.id === activeViewId
                            }
                            onHover={() => setSelected(navItems.indexOf(item))}
                            onActivate={() => onRowActivate(item)}
                            onRemove={
                              summonSpaceRemovable(item) && pickedCount === 0
                                ? () => removeRemovableSpace(item)
                                : undefined
                            }
                            onPeek={
                              item.kind === "widget" && pickedCount === 0
                                ? () => onRowPeek(item)
                                : undefined
                            }
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
          {pickedCount > 0 ? (
            <button
              type="button"
              className="ops-sheet__land-btn"
              onMouseDown={keepSearchFocus}
              onClick={() => land(false)}
            >
              {primaryLabel}
              <kbd className="composer-kbd">↵</kbd>
            </button>
          ) : null}
          <ComposerKbdFooter
            hints={summonFooterHints(current, {
              primary: actionPreview.primary,
              hasQuery: Boolean(query),
              pickableCount,
              keepCount,
              removeCount,
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
  picked,
  staging,
  currentSpace,
  onHover,
  onActivate,
  onPeek,
  onRemove,
}: {
  item: SummonItem
  selected: boolean
  present: boolean
  picked: boolean
  staging: boolean
  currentSpace: boolean
  onHover: () => void
  onActivate: () => void
  /** Right-click peek (surfaces only). */
  onPeek?: () => void
  /** DIY / Zen Space delete (mouse). */
  onRemove?: () => void
}) {
  const keys = summonActionKeys(item, {
    onSpace: present,
    staging,
    picked,
  })
  const isPreset = item.kind === "bundle"
  const isCustom = item.kind === "space" && Boolean(item.custom)
  const isZen = item.kind === "space" && Boolean(item.zen)
  const isWidget = item.kind === "widget"
  const Icon = summonItemIcon(item)
  const statusPill = currentSpace
    ? "Current"
    : present
      ? "Active"
      : null
  const stageMark = picked
    ? present
      ? "−"
      : "✓"
    : ""

  return (
    <li className={onRemove ? "ops-sheet__row-host" : undefined}>
      <button
        id={`summon-option-${summonItemKey(item)}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-checked={isWidget ? picked : undefined}
        aria-label={
          [
            item.name,
            statusPill,
            isZen ? "zen space" : isCustom ? "custom layout" : null,
            picked ? (present ? "staged to remove" : "staged to keep") : null,
          ].filter(Boolean).join(", ")
        }
        className={[
          "ops-sheet__row",
          "ops-sheet__row--interactive",
          selected ? "is-selected" : "",
          picked ? "is-picked" : "",
          picked && present ? "is-picked-remove" : "",
          isPreset ? "ops-sheet__row--preset" : "",
        ].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={onHover}
        onClick={() => onActivate()}
        onContextMenu={(event) => {
          if (!onPeek) return
          event.preventDefault()
          event.stopPropagation()
          onPeek()
        }}
        title={
          isWidget
            ? "Click to stage · Right-click to peek"
            : onRemove
              ? "Enter to open · ⌫ to delete"
              : undefined
        }
      >
        {isWidget ? (
          <span
            className={[
              "ops-sheet__pick",
              picked ? "is-on" : "",
              picked && present ? "is-remove" : "",
            ].filter(Boolean).join(" ")}
            aria-hidden
          >
            {stageMark}
          </span>
        ) : (
          <span className="ops-sheet__pick-spacer" aria-hidden />
        )}
        <span className="ops-sheet__label">
          <Icon size={15} className="ops-sheet__row-icon" aria-hidden />
          <span className="ops-sheet__label-text">{item.name}</span>
          {isPreset ? <span className="ops-sheet__preset-mark">Reset</span> : null}
          {isCustom ? <span className="ops-sheet__preset-mark">Layout</span> : null}
          {isZen ? <span className="ops-sheet__preset-mark">Zen</span> : null}
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
      {onRemove ? (
        <button
          type="button"
          className="ops-sheet__row-delete"
          title="Delete (⌫)"
          aria-label={`Delete ${item.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <X size={12} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </li>
  )
}
