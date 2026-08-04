/**
 * Canvas — blank stage where layout surfaces live.
 *
 * Nested H/V split tree projected onto an absolute grid. Renders surfaces for
 * the active layout and shows an add prompt when empty.
 */

import { LayoutGrid, Plus } from "lucide-react"
import { forwardRef, useImperativeHandle, useState } from "react"
import { useViewingAs } from "../../hooks/useViewingAs"
import { useLayoutStore } from "../../state/layout-store"
import { IntroAsciiField } from "../home/IntroAsciiField"
import { openWidgetCatalogHint } from "../types"
import { WidgetCatalog } from "./WidgetCatalog"
import { GridCanvas } from "./layout/GridCanvas"

export interface CanvasHandle {
  openCatalog: () => void
  toggleCatalog: () => void
}

export const Canvas = forwardRef<CanvasHandle>(function Canvas(_props, ref) {
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const { isViewingAsOther } = useViewingAs()
  // Glyph field is a quiet Viewing-as cue behind the stage — never under solo.
  // No layout pad: gutters come from GridCanvas JS inset (solo can fill the stage).
  const stageGlyphs = isViewingAsOther && !soloTileId
  const [catalogOpen, setCatalogOpen] = useState(false)
  const catalogHint = openWidgetCatalogHint()

  useImperativeHandle(
    ref,
    () => ({
      openCatalog: () => setCatalogOpen(true),
      toggleCatalog: () => setCatalogOpen((open) => !open),
    }),
    [],
  )

  const activeView = views.find((view) => view.id === activeViewId)
  if (!activeView) return null

  const { tiles, split } = activeView

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {stageGlyphs && (
        <div className="workspace-stage-glyphs pointer-events-none overflow-hidden" aria-hidden>
          <IntroAsciiField surface="home" viewingAsField />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 p-2">
            <LayoutGrid size={48} className="text-text-faint" strokeWidth={1.5} />
            <div className="text-center">
              <p className="mb-1 text-base text-text-secondary">This layout is empty</p>
              <p className="text-sm text-text-muted max-w-sm">
                Add surfaces to this layout.
              </p>
            </div>
            <button
              type="button"
              className="toolbar-ops-btn shrink-0 px-4"
              onClick={() => setCatalogOpen(true)}
              title={`Add surfaces to this layout (${catalogHint})`}
              aria-label={`Add surfaces to this layout (${catalogHint})`}
            >
              <Plus size={15} className="block shrink-0" aria-hidden />
              Add to layout
              <span className="font-mono text-[11px] text-text-faint" aria-hidden>
                {catalogHint}
              </span>
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
