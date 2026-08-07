/**
 * Spatial blueprint — toolbar popover or Summon embedded canvas.
 * Embedded = tiles only (Summon owns the flush rail header).
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
  selectablePreviewLeaves,
  spacePreviewLeafStyle,
} from "../../lib/space-layout-preview"
import type { SplitNode } from "../../lib/split-tree"
import type { WidgetType } from "../../types"
import { getWidgetDefinition } from "./widget-definitions"

export function SpaceLayoutPreview({
  name,
  split,
  tiles,
  style,
  onSelectTile,
  onDismiss,
  variant = "popover",
  meta,
  hotkeyHint: hotkeyHintProp,
  highlightPickIndex = null,
}: {
  name: string
  split: SplitNode | null
  tiles: readonly { id: string; type: WidgetType }[]
  /** Anchor under the tab (cluster-relative) — popover only. */
  style?: CSSProperties
  onSelectTile?: (tileId: string) => void
  onDismiss?: () => void
  variant?: "popover" | "embedded"
  /** Optional subtitle — popover only (Summon paints meta outside). */
  meta?: string
  hotkeyHint?: string
  highlightPickIndex?: number | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const leaves = projectSpaceLayoutPreview(split, tiles)
  const pickable = useMemo(() => selectablePreviewLeaves(leaves), [leaves])
  const tileCount = pickable.length
  const displayName = name.trim() || "Untitled"
  const embedded = variant === "embedded"
  const hotkeyHint =
    hotkeyHintProp
    ?? (tileCount <= 1 ? "1" : tileCount <= 9 ? `1–${tileCount}` : "1–9")

  useEffect(() => {
    if (embedded) return
    rootRef.current?.focus({ preventScroll: true })
  }, [embedded])

  function onInspectorKeyDown(event: ReactKeyboardEvent) {
    if (embedded) return
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

  const canvas = (
    <div className="space-layout-preview__canvas">
      {leaves.map((leaf) => {
        const pickIndex = pickable.findIndex((item) => item.tileId === leaf.tileId)
        const hotkey = pickIndex >= 0 ? String(pickIndex + 1) : null
        const highlighted =
          highlightPickIndex != null && pickIndex === highlightPickIndex

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
              <Icon size={18} className="space-layout-preview__leaf-icon" aria-hidden />
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
                role={embedded ? "button" : "menuitem"}
                tabIndex={-1}
                className={[
                  "space-layout-preview__leaf-inner",
                  "space-layout-preview__leaf-inner--link",
                  highlighted ? "is-highlighted" : "",
                ].filter(Boolean).join(" ")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectTile?.(leaf.tileId)}
              >
                {inner}
              </button>
            ) : (
              <div
                className={[
                  "space-layout-preview__leaf-inner",
                  highlighted ? "is-highlighted" : "",
                ].filter(Boolean).join(" ")}
              >
                {inner}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  if (embedded) {
    return (
      <div
        className="space-layout-preview space-layout-preview--embedded"
        role="region"
        aria-label={`${displayName} space`}
      >
        {canvas}
      </div>
    )
  }

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
        {meta ? <p className="space-layout-preview__meta">{meta}</p> : null}
        {canvas}
      </div>
    </div>
  )
}
