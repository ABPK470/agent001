/**
 * Widget mount → whether to claim the operator surface (tile focus or peek).
 */

import { useWidgetInstance } from "../app/workspace/widget-instance"
import { isOperatorSurfaceArmed } from "../lib/operator-surface-armed"
import { useLayoutStore } from "../state/layout-store"
import { useStore } from "../state/store"

export function useOperatorSurfaceArmed(options?: { layoutFocus?: boolean }): boolean {
  const instance = useWidgetInstance()
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const modalWidget = useStore((s) => s.modalWidget)
  const summonOpen = useStore((s) => s.summonOpen)
  const keymapSheetOpen = useStore((s) => s.keymapSheetOpen)

  return isOperatorSurfaceArmed({
    instance,
    focusedTileId,
    modalWidgetType: modalWidget?.type ?? null,
    summonOpen,
    keymapSheetOpen,
    layoutFocus: options?.layoutFocus,
  })
}
