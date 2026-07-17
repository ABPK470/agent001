/**
 * Canvas — the blank canvas where widgets live.
 *
 * Flat absolute 2D grid with custom drag/resize. Renders widgets for the
 * active view and shows an add-widget prompt when empty.
 */

import { LayoutGrid, Plus } from "lucide-react"
import { forwardRef, useImperativeHandle, useState } from "react"
import { useLayoutStore } from "../../state/layout-store"
import { WidgetCatalog } from "./WidgetCatalog"
import { GridCanvas } from "./layout/GridCanvas"

export interface CanvasHandle {
  openCatalog: () => void
}

export const Canvas = forwardRef<CanvasHandle>(function Canvas(_props, ref) {
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const [catalogOpen, setCatalogOpen] = useState(false)

  useImperativeHandle(ref, () => ({ openCatalog: () => setCatalogOpen(true) }), [])

  const activeView = views.find((view) => view.id === activeViewId)
  if (!activeView) return null

  const { tiles } = activeView

  return (
    <div className="relative flex-1 overflow-hidden">
      {tiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-5 p-2">
          <LayoutGrid size={48} className="text-text-faint" strokeWidth={1.5} />
          <div className="text-center">
            <p className="text-base text-text-secondary mb-1">Your canvas is empty</p>
            <p className="text-sm text-text-muted">Add widgets to build your dashboard</p>
          </div>
          <button
            type="button"
            className="flex items-center gap-2 px-6 py-2.5 text-text-secondary hover:text-text text-sm border border-border hover:border-text-secondary/25 rounded-xl transition-colors"
            onClick={() => setCatalogOpen(true)}
          >
            <Plus size={16} />
            Add Widget
          </button>
        </div>
      ) : (
        <GridCanvas viewId={activeViewId} tiles={tiles} onOpenCatalog={() => setCatalogOpen(true)} />
      )}

      {catalogOpen && <WidgetCatalog onClose={() => setCatalogOpen(false)} />}
    </div>
  )
})
