/**
 * Toolbar — top rail of the workspace paper sheet.
 *
 * One bright bar: layouts (left) | ops (right), full-height divider between.
 * Active sheet = shade fill + weight (selection dialect — never underline / accent).
 * Ops controls = bordered quiet chrome (same family as .mia-control).
 */

import { ChevronDown, ChevronRight, GripVertical, LayoutGrid, Minimize2, Plus, X } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
} from "react"
import type { Me } from "../../hooks/useMe"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import {
  clampSpacePreviewAnchor,
  nextSpacePreviewAnchor,
} from "../../lib/space-layout-preview"
import {
  SPACE_PREVIEW_WIDTH_REM,
  spaceLayoutInspectorEligible,
} from "../../lib/space-layout-inspector-nav"
import { peerSlidePx } from "../../lib/view-tab-dnd"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import { NotificationPanel } from "../../widgets/platform/NotificationPanel"
import { ChatBrand } from "../ChatBrand"
import { SessionMenu } from "../SessionMenu"
import { ViewingAsControl } from "../ViewingAsControl"
import { SHELL_CHROME_HEADER_WORKSPACE_CLASS } from "../shell-chrome"
import type { AppShellMode } from "../types"
import { isProductSpaceAtDefault, isProductSpaceId } from "../../lib/spaces"
import { openWidgetCatalogHint } from "../types"
import { OpenWidgetCatalogHintMark } from "./OpenWidgetCatalogHint"
import { captureSoloFlipForTileId } from "./layout/solo-flip"
import { SpaceLayoutPreview } from "./SpaceLayoutPreview"
import { ViewTabDragFloat } from "./ViewTabDragFloat"
import { getWidgetDefinition } from "./widget-definitions"

/** Local harness only — remove with packages/ui/src/local-harness/. */
async function loadLocalRunSimulateControl(): Promise<ComponentType | null> {
  if (import.meta.env.DEV !== true || import.meta.env.VITE_LOCAL_RUN_SIMULATE !== "1") {
    return null
  }
  const mod = await import("../../local-harness/run-simulate/WorkspaceSimulateControl")
  return mod.WorkspaceSimulateControl
}

function LocalRunSimulateSlot() {
  const [Control, setControl] = useState<ComponentType | null>(null)
  useEffect(() => {
    void loadLocalRunSimulateControl()
      .then((Loaded) => {
        // Function form — a component is itself a function; bare setState would invoke it.
        setControl(() => Loaded)
      })
      .catch((err: unknown) => {
        console.error("[mia] local sim control load failed", err)
      })
  }, [])
  if (!Control) return null
  return <Control />
}

interface Props {
  onAddWidget?: () => void
  onSignOut: () => void
  onModeChange: (mode: AppShellMode) => void
  me?: Me | null
}

export function Toolbar({ onAddWidget, onSignOut, onModeChange, me }: Props) {
  const connected = useStore((s) => s.connected)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const setActiveView = useLayoutStore((s) => s.setActiveView)
  const setFocusedTile = useLayoutStore((s) => s.setFocusedTile)
  const addView = useLayoutStore((s) => s.addView)
  const removeView = useLayoutStore((s) => s.removeView)
  const resetActiveSpace = useLayoutStore((s) => s.resetActiveSpace)
  const viewportRows = useLayoutStore((s) => s.viewportRows)
  const catalogHint = openWidgetCatalogHint()
  const renameView = useLayoutStore((s) => s.renameView)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const toggleTileMaximized = useLayoutStore((s) => s.toggleTileMaximized)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const tabsRef = useRef<HTMLDivElement>(null)
  const clusterRef = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorViewId, setInspectorViewId] = useState<string | null>(null)
  const [previewAnchorPx, setPreviewAnchorPx] = useState(0)
  const {
    draggingId,
    homeSlot,
    dropSlot,
    dragWidthPx,
    gapPx,
    float,
    slideAnimated,
    pointerSession,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  } = useViewTabReorder(tabsRef, editing)

  useEffect(() => {
    if (!moreOpen) return
    function onPointerDown(event: PointerEvent) {
      if (moreRef.current?.contains(event.target as Node)) return
      setMoreOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [moreOpen])

  useEffect(() => {
    if (!inspectorOpen) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (clusterRef.current?.contains(target)) return
      closeInspector()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [inspectorOpen])

  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    function check(): void {
      const strip = tabsRef.current
      if (!strip) return
      setTabsOverflow(strip.scrollWidth > strip.clientWidth + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [views])

  useEffect(() => {
    if (draggingId || pointerSession) return
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-view-id="${activeViewId}"]`)
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
  }, [activeViewId, draggingId, pointerSession])

  useEffect(() => {
    if (!tabsOverflow) setMoreOpen(false)
  }, [tabsOverflow])

  function measureTabAnchorPx(viewId: string): number | null {
    const cluster = clusterRef.current
    if (!cluster) return null
    const tab = cluster.querySelector(`[data-view-id="${CSS.escape(viewId)}"]`)
    if (!(tab instanceof HTMLElement)) return null
    const clusterBox = cluster.getBoundingClientRect()
    const tabBox = tab.getBoundingClientRect()
    const center = tabBox.left - clusterBox.left + tabBox.width / 2
    const rootPx = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize || "16",
    )
    const previewWidthPx =
      SPACE_PREVIEW_WIDTH_REM * (Number.isFinite(rootPx) && rootPx > 0 ? rootPx : 16)
    return clampSpacePreviewAnchor(center, previewWidthPx, clusterBox.width)
  }

  function retargetInspectorAnchor(viewId: string, opts?: { force?: boolean }) {
    const desired = measureTabAnchorPx(viewId)
    if (desired == null) return
    if (opts?.force) {
      setPreviewAnchorPx(desired)
      return
    }
    setPreviewAnchorPx((current) => nextSpacePreviewAnchor(current, desired))
  }

  function setInspectorContent(viewId: string) {
    setInspectorViewId(viewId)
  }

  function openInspector(viewId: string) {
    if (draggingId || editing) return
    if (!inspectorOpen) {
      retargetInspectorAnchor(viewId, { force: true })
      setInspectorOpen(true)
    } else {
      retargetInspectorAnchor(viewId)
    }
    setInspectorContent(viewId)
  }

  function toggleInspector(viewId: string) {
    if (draggingId || editing) return
    if (inspectorOpen && inspectorViewId === viewId) {
      closeInspector()
      return
    }
    openInspector(viewId)
  }

  function closeInspector() {
    setInspectorOpen(false)
    setInspectorViewId(null)
  }

  function onTabInspectorHover(viewId: string) {
    if (!inspectorOpen || draggingId || editing) return
    if (inspectorViewId === viewId) return
    setInspectorContent(viewId)
    retargetInspectorAnchor(viewId)
  }

  function onPreviewSelectTile(viewId: string, tileId: string) {
    if (viewId !== activeViewId) setActiveView(viewId)
    setFocusedTile(tileId)
    closeInspector()
  }

  useEffect(() => {
    if (!draggingId && !editing) return
    closeInspector()
  }, [draggingId, editing])

  useEffect(() => {
    if (!inspectorOpen || !inspectorViewId) return
    const cluster = clusterRef.current
    if (!cluster) return
    const viewId = inspectorViewId
    function onResize() {
      retargetInspectorAnchor(viewId, { force: true })
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(cluster)
    return () => ro.disconnect()
  }, [inspectorOpen, inspectorViewId])

  function handleDoubleClick(id: string, name: string) {
    if (isProductSpaceId(id)) return
    setEditing(id)
    setEditName(name)
  }

  function layoutFallbackName(id: string): string {
    return `Layout ${id.slice(0, 4)}`
  }

  function handleRename(id: string) {
    const trimmed = editName.trim()
    if (trimmed) {
      renameView(id, trimmed)
      setEditing(null)
      return
    }
    const existing = views.find((view) => view.id === id)?.name.trim()
    if (existing) {
      setEditing(null)
      return
    }
    renameView(id, layoutFallbackName(id))
    setEditing(null)
  }

  function handleAddLayout() {
    const id = addView("")
    setEditing(id)
    setEditName("")
  }

  function handleRenameKeyDown(id: string, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      handleRename(id)
      return
    }
    if (event.key !== "Escape") return
    const existing = views.find((view) => view.id === id)?.name.trim()
    if (!existing && !editName.trim()) {
      renameView(id, layoutFallbackName(id))
    }
    setEditing(null)
  }

  const activeView = views.find((view) => view.id === activeViewId)
  const previewView = inspectorViewId
    ? views.find((view) => view.id === inspectorViewId)
    : undefined
  const soloTile = soloTileId
    ? activeView?.tiles.find((tile) => tile.id === soloTileId)
    : undefined
  const soloLabel = soloTile ? getWidgetDefinition(soloTile.type).label : null
  const consoleIsAdmin = useLayoutStore((s) => s.consoleIsAdmin)
  const showResetSpace =
    Boolean(activeView)
    && isProductSpaceId(activeViewId)
    && !isProductSpaceAtDefault(activeView!, viewportRows, consoleIsAdmin)
  const stageOpen =
    Boolean(onAddWidget) || Boolean(soloLabel && soloTileId) || showResetSpace

  return (
    <header className={SHELL_CHROME_HEADER_WORKSPACE_CLASS}>
      <ChatBrand connected={connected} />

      {/* Layouts — chips + · More; + hugs the last chip. */}
      <div
        className="toolbar-views"
        role="navigation"
        aria-label="Layouts"
      >
        <div
          ref={clusterRef}
          className={`view-tab-cluster${inspectorOpen ? " view-tab-cluster--inspector-open" : ""}`}
        >
        <div
          ref={tabsRef}
          className={[
            "view-tab-strip flex overflow-x-auto scrollbar-none",
            tabsOverflow ? "view-tab-strip--overflow" : "",
          ].filter(Boolean).join(" ")}
          {...(draggingId
            ? {
                "data-reordering": "",
                ...(slideAnimated ? { "data-reorder-animate": "" } : {}),
              }
            : {})}
        >
          {views.map((view, fullIndex) => {
            const isDragging = draggingId === view.id
            const isActive = view.id === activeViewId
            const slide = !isDragging && draggingId && dropSlot != null
              ? peerSlidePx(fullIndex, homeSlot, dropSlot, dragWidthPx, gapPx)
              : 0

            const inspectorEligible = spaceLayoutInspectorEligible(view.tiles.length)
            const inspectorPreview = inspectorOpen && inspectorViewId === view.id

            return (
              <div
                key={view.id}
                data-view-id={view.id}
                {...(isDragging ? { "data-view-dragging": "" } : {})}
                className={[
                  "view-tab group",
                  isActive ? "view-tab--active" : "view-tab--inactive",
                  draggingId && !isDragging ? "view-tab-peer-dim" : "",
                  isDragging ? "view-tab-dragging" : "",
                  inspectorPreview ? "view-tab--inspector-open" : "",
                ].join(" ")}
                style={
                  draggingId && !isDragging
                    ? { transform: `translate3d(${slide}px,0,0)` }
                    : undefined
                }
                onPointerEnter={() => onTabInspectorHover(view.id)}
                onPointerDown={(event) => {
                  if (!(event.target as Element).closest?.(".view-tab__chevron")) {
                    closeInspector()
                  }
                  onTabPointerDown(view.id, event)
                }}
                onPointerMove={onTabPointerMove}
                onPointerUp={onTabPointerUp}
                onPointerCancel={onTabPointerCancel}
                onLostPointerCapture={onTabLostPointerCapture}
                onDoubleClick={() => handleDoubleClick(view.id, view.name)}
                onContextMenu={(event) => {
                  if (!inspectorEligible) return
                  event.preventDefault()
                  openInspector(view.id)
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || views.length <= 1) return
                  event.preventDefault()
                  event.stopPropagation()
                  removeView(view.id)
                }}
                title={
                  inspectorEligible
                    ? views.length > 1
                      ? "Click to open · chevron or right-click for space · middle-click to close · drag grip to reorder"
                      : "Click to open · chevron or right-click for space · drag grip to reorder"
                    : views.length > 1
                      ? "Click to open · middle-click to close · drag the grip to reorder"
                      : "Click to open · drag the grip to reorder"
                }
              >
                <GripVertical
                  size={12}
                  className="view-tab__grip relative z-[2] shrink-0"
                  aria-hidden
                />
                {editing === view.id ? (
                  <input
                    className="relative z-[2] w-28 border-none bg-transparent text-[13px] text-text outline-none placeholder:text-text-faint"
                    value={editName}
                    placeholder="Name this layout"
                    aria-label="Layout name"
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRename(view.id)}
                    onKeyDown={(e) => handleRenameKeyDown(view.id, e)}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="view-tab__label relative z-[2] whitespace-nowrap">
                    {view.name || "Untitled"}
                  </span>
                )}
                {inspectorEligible ? (
                  <button
                    type="button"
                    className={`view-tab__chevron relative z-[2]${inspectorPreview ? " is-open" : ""}`}
                    aria-label={`${view.name || "Space"} tile map`}
                    aria-expanded={inspectorPreview}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleInspector(view.id)
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      openInspector(view.id)
                    }}
                  >
                    <ChevronRight size={12} aria-hidden />
                  </button>
                ) : null}
                {views.length > 1 && (
                  <button
                    type="button"
                    className="view-tab__close relative z-[2]"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeView(view.id)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Close layout"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}

          {float && <ViewTabDragFloat float={float} />}
        </div>

        {/* Pinned — new blank layout; surfaces come from Add (catalog modal). */}
        <button
          type="button"
          className={[
            "view-tab-add flex shrink-0 items-center justify-center text-text-muted transition-colors hover:text-text",
            draggingId ? "pointer-events-none opacity-50" : "",
          ].filter(Boolean).join(" ")}
          onClick={handleAddLayout}
          title="Add layout"
          aria-label="Add layout"
        >
          <Plus size={16} />
        </button>

        {tabsOverflow && (
          <div className="relative flex shrink-0 items-center self-center" ref={moreRef}>
            <button
              type="button"
              className="toolbar-ops-btn shrink-0 px-2.5"
              onClick={() => setMoreOpen((value) => !value)}
              title="All layouts"
              aria-expanded={moreOpen}
            >
              <span className="hidden leading-none sm:inline">More</span>
              <ChevronDown size={14} className="block shrink-0" />
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-border bg-panel-2 py-1.5 shadow-xl shadow-black/40">
                {views.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                      view.id === activeViewId
                        ? "font-semibold text-text bg-[var(--select-fill)]"
                        : "text-text-secondary hover:text-text hover:bg-[var(--hover-fill)]"
                    }`}
                    onClick={() => {
                      setActiveView(view.id)
                      setMoreOpen(false)
                    }}
                  >
                    <span className="truncate">{view.name}</span>
                    {view.id === activeViewId && (
                      <span className="text-xs text-text-faint">·</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {inspectorOpen && previewView && !draggingId && !editing ? (
          <SpaceLayoutPreview
            key={previewView.id}
            name={previewView.name}
            split={previewView.split}
            tiles={previewView.tiles}
            style={
              {
                ["--space-preview-anchor"]: `${previewAnchorPx}px`,
              } as CSSProperties
            }
            onSelectTile={(tileId) => onPreviewSelectTile(previewView.id, tileId)}
            onDismiss={closeInspector}
          />
        ) : null}
        </div>
      </div>

      {/* Ops — outlined controls; full-height rule separates from layouts. */}
      <div className="toolbar-ops-tray">
        {stageOpen && (
          <>
            <div className="flex h-9 shrink-0 items-center gap-1.5" aria-label="Layout tools">
              {soloLabel && soloTileId && (
                <button
                  type="button"
                  className="toolbar-ops-btn toolbar-ops-btn--active max-w-[14rem] shrink-0 px-2.5"
                  onClick={() => {
                    captureSoloFlipForTileId(soloTileId)
                    toggleTileMaximized(activeViewId, soloTileId)
                  }}
                  title={`Restore ${soloLabel}`}
                  aria-label={`Restore ${soloLabel}`}
                >
                  <Minimize2 size={15} className="block shrink-0" aria-hidden />
                  <span className="min-w-0 truncate font-medium leading-none">{soloLabel}</span>
                </button>
              )}
              {showResetSpace ? (
                <button
                  type="button"
                  className="toolbar-ops-btn shrink-0 px-2.5"
                  onClick={() => resetActiveSpace()}
                  title="Reset this Space to its curated default"
                >
                  <span className="hidden leading-none sm:inline">Reset Space</span>
                </button>
              ) : null}
              {onAddWidget && (
                <>
                  <button
                    type="button"
                    className="toolbar-ops-btn toolbar-ops-btn--summon shrink-0"
                    onClick={onAddWidget}
                    title={`Summon (${catalogHint})`}
                    aria-label={`Summon (${catalogHint})`}
                  >
                    <LayoutGrid size={15} className="block shrink-0" aria-hidden />
                    <span className="hidden leading-none sm:inline">Summon</span>
                    <span className="hidden sm:contents">
                      <OpenWidgetCatalogHintMark />
                    </span>
                  </button>
                </>
              )}
              <LocalRunSimulateSlot />
            </div>
            <div className="toolbar-shell-divider" aria-hidden />
          </>
        )}

        <div className="flex h-9 shrink-0 items-center gap-1.5" aria-label="Session">
          <NotificationPanel />
          <ViewingAsControl />
          {me && (
            <SessionMenu
              me={me}
              onSignOut={onSignOut}
              onOpenChat={() => onModeChange("chat")}
            />
          )}
        </div>
      </div>
    </header>
  )
}
