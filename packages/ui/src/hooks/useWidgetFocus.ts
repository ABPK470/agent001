/**
 * Per-tile zen / focus mode — reads layout store + widget instance context.
 */

import { useWidgetInstance } from "../app/workspace/widget-instance"
import { captureSoloFlipForTileId } from "../app/workspace/layout/solo-flip"
import { widgetSupportsFocusMode } from "../lib/widget-focus"
import { useLayoutStore } from "../state/layout-store"

export function useWidgetFocus() {
  const instance = useWidgetInstance()
  const zenActive = useLayoutStore((s) => s.zenActive)
  const zenSet = useLayoutStore((s) => s.zenSet)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const toggleTileZen = useLayoutStore((s) => s.toggleTileZen)
  const exitTileZen = useLayoutStore((s) => s.exitTileZen)

  const tileId = instance?.widgetId ?? null
  const viewId = instance?.viewId ?? null
  const supportsFocus = instance ? widgetSupportsFocusMode(instance.type) : false
  const isZen =
    supportsFocus &&
    Boolean(zenActive && tileId && zenSet.includes(tileId))
  const isSolo = Boolean(tileId && soloTileId === tileId)

  function toggleZen() {
    if (!viewId || !tileId || !supportsFocus) return
    // Entering zen also sets solo — same FLIP as chrome click.
    // Exit zen leaves solo (no geometry change) — do not arm a stale flip.
    if (!isZen) captureSoloFlipForTileId(tileId)
    toggleTileZen(viewId, tileId)
  }

  function exitZen() {
    if (!isZen) return
    exitTileZen()
  }

  return {
    supportsFocus,
    isZen,
    isSolo,
    toggleZen,
    exitZen,
  }
}
