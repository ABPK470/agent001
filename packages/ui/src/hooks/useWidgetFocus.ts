/**
 * Per-tile zen / focus mode — reads layout store + widget instance context.
 */

import { useLayoutStore } from "../state/layout-store"
import { useWidgetInstance } from "../app/workspace/widget-instance"
import { widgetSupportsFocusMode } from "../lib/widget-focus"

export function useWidgetFocus() {
  const instance = useWidgetInstance()
  const zenTileId = useLayoutStore((s) => s.zenTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const toggleTileZen = useLayoutStore((s) => s.toggleTileZen)
  const exitTileZen = useLayoutStore((s) => s.exitTileZen)

  const tileId = instance?.widgetId ?? null
  const viewId = instance?.viewId ?? null
  const supportsFocus = instance ? widgetSupportsFocusMode(instance.type) : false
  const isZen = supportsFocus && Boolean(tileId && zenTileId === tileId)
  const isSolo = Boolean(tileId && soloTileId === tileId)

  function toggleZen() {
    if (!viewId || !tileId || !supportsFocus) return
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
