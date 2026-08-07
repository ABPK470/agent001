/**
 * Canvas — blank stage where layout surfaces live.
 *
 * Nested H/V split tree projected onto an absolute grid. Renders surfaces for
 * the active layout and shows a Summon prompt when empty.
 */

import { LayoutGrid } from "lucide-react"
import { forwardRef, useImperativeHandle } from "react"
import { useViewingAs } from "../../hooks/useViewingAs"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import { IntroAsciiField } from "../home/IntroAsciiField"
import { openWidgetCatalogHint } from "../types"
import { OpenWidgetCatalogHintMark } from "./OpenWidgetCatalogHint"
import { GridCanvas } from "./layout/GridCanvas"

export interface CanvasHandle {
  /** Opens Summon (legacy name kept for App ref wiring). */
  openCatalog: () => void
  toggleCatalog: () => void
}

export const Canvas = forwardRef<CanvasHandle>(function Canvas(_props, ref) {
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenActive = useLayoutStore((s) => s.zenActive)
  const ensureProductSpaces = useLayoutStore((s) => s.ensureProductSpaces)
  const setSummonOpen = useStore((s) => s.setSummonOpen)
  const toggleSummon = useStore((s) => s.toggleSummon)
  const { isViewingAsOther } = useViewingAs()
  // Glyph field is a quiet Viewing-as cue behind the stage — never under solo.
  // No layout pad: gutters come from GridCanvas JS inset (solo can fill the stage).
  const stageGlyphs = isViewingAsOther && !soloTileId && !zenActive
  const summonHint = openWidgetCatalogHint()

  function openSummon() {
    ensureProductSpaces()
    setSummonOpen(true)
  }

  useImperativeHandle(
    ref,
    () => ({
      openCatalog: openSummon,
      toggleCatalog: () => {
        ensureProductSpaces()
        toggleSummon()
      },
    }),
    [ensureProductSpaces, setSummonOpen, toggleSummon],
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
                Summon a surface onto this Space.
              </p>
            </div>
            <button
              type="button"
              className="toolbar-ops-btn toolbar-ops-btn--summon shrink-0"
              onClick={openSummon}
              title={`Summon (${summonHint})`}
              aria-label={`Summon (${summonHint})`}
            >
              <LayoutGrid size={15} className="block shrink-0" aria-hidden />
              Summon
              <OpenWidgetCatalogHintMark />
            </button>
          </div>
        ) : (
          <GridCanvas
            viewId={activeViewId}
            tiles={tiles}
            split={split}
          />
        )}
      </div>
    </div>
  )
})
