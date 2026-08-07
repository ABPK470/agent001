/**
 * Spatial Inspector — layout blueprint under a Space tab.
 * Click/right-click/chevron opens; digit hotkeys focus tiles directly.
 * Each leaf: centered surface icon + name (no fake content chrome).
 */

import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { tileHotkeyIndex } from "../../lib/space-layout-inspector-nav"
import {
  projectSpaceLayoutPreview,
  spacePreviewLeafStyle,
  type SpacePreviewLeaf,
} from "../../lib/space-layout-preview"
import type { SplitNode } from "../../lib/split-tree"
import type { WidgetType } from "../../types"
import { getWidgetDefinition } from "./widget-definitions"

function selectableLeaves(leaves: readonly SpacePreviewLeaf[]): SpacePreviewLeaf[] {
  return leaves.filter((leaf) => leaf.type != null && leaf.tileId !== "__empty__")
}

export function SpaceLayoutPreview({
  name,
  split,
  tiles,
  style,
  onSelectTile,
  onDismiss,
}: {
  name: string
  split: SplitNode | null
  tiles: readonly { id: string; type: WidgetType }[]
  /** Anchor under the tab (cluster-relative). */
  style?: CSSProperties
  onSelectTile?: (tileId: string) => void
  onDismiss?: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const leaves = projectSpaceLayoutPreview(split, tiles)
  const pickable = useMemo(() => selectableLeaves(leaves), [leaves])
  const tileCount = pickable.length
  const displayName = name.trim() || "Untitled"

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  function onInspectorKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onDismiss?.()
      return
    }
    if (event.key === "Enter" && pickable[0] && onSelectTile) {
      event.preventDefault()
      event.stopPropagation()
      onSelectTile(pickable[0].tileId)
      return
    }
    const index = tileHotkeyIndex(event.key, pickable.length)
    if (index == null || !onSelectTile) return
    const leaf = pickable[index]
    if (!leaf) return
    event.preventDefault()
    event.stopPropagation()
    onSelectTile(leaf.tileId)
  }

  const hotkeyHint =
    tileCount <= 1 ? "1" : tileCount <= 9 ? `1–${tileCount}` : "1–9"

  return (
    <div
      ref={rootRef}
      className="space-layout-preview"
      role="menu"
      aria-label={`${displayName} space`}
      tabIndex={-1}
      style={style}
      onKeyDown={onInspectorKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="space-layout-preview__shell">
        <div className="space-layout-preview__head">
          <span className="space-layout-preview__head-title">
            {displayName} · Space
          </span>
          <span className="space-layout-preview__head-hints" aria-hidden>
            <span className="space-layout-preview__head-hint">
              <kbd className="space-layout-preview__head-kbd">↵</kbd>
              <span>open</span>
            </span>
            <span className="space-layout-preview__head-hint">
              <kbd className="space-layout-preview__head-kbd tabular-nums">{hotkeyHint}</kbd>
              <span>tile</span>
            </span>
            <span className="space-layout-preview__head-hint">
              <kbd className="space-layout-preview__head-kbd">Esc</kbd>
              <span>close</span>
            </span>
          </span>
        </div>
        <div className="space-layout-preview__canvas">
          {leaves.map((leaf) => {
            const pickIndex = pickable.findIndex((item) => item.tileId === leaf.tileId)
            const hotkey = pickIndex >= 0 ? String(pickIndex + 1) : null

            if (!leaf.type) {
              return (
                <div
                  key={leaf.tileId}
                  className="space-layout-preview__leaf"
                  style={spacePreviewLeafStyle(leaf.rect)}
                >
                  <div className="space-layout-preview__leaf-inner space-layout-preview__leaf-inner--empty">
                    <span className="space-layout-preview__leaf-label">Empty</span>
                  </div>
                </div>
              )
            }

            const def = getWidgetDefinition(leaf.type)
            const Icon = def.icon
            const selectable = Boolean(onSelectTile)

            const inner = (
              <>
                {hotkey ? (
                  <kbd className="space-layout-preview__leaf-hotkey tabular-nums">{hotkey}</kbd>
                ) : null}
                <span className="space-layout-preview__leaf-body">
                  <Icon size={18} strokeWidth={1.75} className="space-layout-preview__leaf-icon" aria-hidden />
                  <span className="space-layout-preview__leaf-label">{def.label}</span>
                </span>
              </>
            )

            return (
              <div
                key={leaf.tileId}
                className="space-layout-preview__leaf"
                style={spacePreviewLeafStyle(leaf.rect)}
              >
                {selectable ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="space-layout-preview__leaf-inner space-layout-preview__leaf-inner--link"
                    onClick={() => onSelectTile?.(leaf.tileId)}
                    title={`Focus ${def.label}`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div className="space-layout-preview__leaf-inner">{inner}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
