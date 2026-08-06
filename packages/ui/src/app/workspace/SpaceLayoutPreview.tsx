/**
 * Fixed-geometry Space layout preview — shell size never changes;
 * leaf projection swaps with the hovered view. Leaves are active
 * links: click focuses that surface on the Space.
 *
 * Outer frame starts at the cluster edge with transparent top padding so
 * the pointer never crosses a dead zone on the way into the menu.
 */

import type { CSSProperties } from "react"
import {
  projectSpaceLayoutPreview,
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
}: {
  name: string
  split: SplitNode | null
  tiles: readonly { id: string; type: WidgetType }[]
  /** Anchor under the hovered tab (cluster-relative). */
  style?: CSSProperties
  onSelectTile?: (tileId: string) => void
}) {
  const leaves = projectSpaceLayoutPreview(split, tiles)

  return (
    <div
      className="space-layout-preview"
      role="menu"
      aria-label={`${name || "Untitled"} surfaces`}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="space-layout-preview__shell">
        <div className="space-layout-preview__title">{name || "Untitled"}</div>
        <div className="space-layout-preview__canvas">
          {leaves.map((leaf) => {
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
                    title={`Open ${def.label}`}
                  >
                    <Icon size={16} className="space-layout-preview__leaf-icon" aria-hidden />
                    <span className="space-layout-preview__leaf-label">{def.label}</span>
                  </button>
                ) : (
                  <div className="space-layout-preview__leaf-inner">
                    <Icon size={16} className="space-layout-preview__leaf-icon" aria-hidden />
                    <span className="space-layout-preview__leaf-label">{def.label}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
