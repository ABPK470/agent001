/**
 * Canvas — the blank canvas where widgets live.
 *
 * Nested H/V split tree projected onto an absolute grid. Renders widgets for
 * the active view and shows an add-widget prompt when empty.
 */

import { LayoutGrid, Plus } from "lucide-react"
import { forwardRef, useImperativeHandle, useState } from "react"
import { useViewingAs } from "../../hooks/useViewingAs"
import { useLayoutStore } from "../../state/layout-store"
import { IntroAsciiField } from "../home/IntroAsciiField"
import { WidgetCatalog } from "./WidgetCatalog"
import { GridCanvas } from "./layout/GridCanvas"

export interface CanvasHandle {
  openCatalog: () => void
}

export const Canvas = forwardRef<CanvasHandle>(function Canvas(_props, ref) {
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const { canViewAs, isViewingAsOther } = useViewingAs()
  const stageGlyphs = canViewAs && isViewingAsOther
  const [catalogOpen, setCatalogOpen] = useState(false)

  useImperativeHandle(ref, () => ({ openCatalog: () => setCatalogOpen(true) }), [])

  const activeView = views.find((view) => view.id === activeViewId)
  if (!activeView) return null

  const { tiles, split } = activeView

  return (
    <div className="relative flex-1 overflow-hidden">
      {stageGlyphs && (
        <div className="workspace-stage-glyphs pointer-events-none overflow-hidden" aria-hidden>
          <IntroAsciiField surface="home" viewingAsField />
        </div>
      )}

      <div className={["relative h-full min-h-0", stageGlyphs ? "workspace-stage-glyphs-pad" : ""].filter(Boolean).join(" ")}>
        {tiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-2">
            <LayoutGrid size={48} className="text-text-faint" strokeWidth={1.5} />
            <div className="text-center">
              <p className="mb-1 text-base text-text-secondary">Your canvas is empty</p>
              <p className="text-sm text-text-muted">Add widgets to build your dashboard</p>
            </div>
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl border border-border px-6 py-2.5 text-sm text-text-secondary transition-colors hover:border-text-secondary/25 hover:text-text"
              onClick={() => setCatalogOpen(true)}
            >
              <Plus size={16} />
              Add Widget
            </button>
          </div>
        ) : (
          <GridCanvas
            viewId={activeViewId}
            tiles={tiles}
            split={split}
            onOpenCatalog={() => setCatalogOpen(true)}
          />
        )}
      </div>

      {catalogOpen && <WidgetCatalog onClose={() => setCatalogOpen(false)} />}
    </div>
  )
})
