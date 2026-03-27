/**
 * Canvas — the blank canvas where widgets live.
 *
 * Uses react-grid-layout for drag/resize/snap grid behavior.
 * Renders the widgets for the active view.
 * Shows an "add widget" prompt when empty.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Responsive, WidthProvider } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import { useStore } from "../store"
import type { LayoutItem } from "../types"
import { widgetRegistry } from "../widgets"
import { WidgetCatalog } from "./WidgetCatalog"
import { WidgetFrame } from "./WidgetFrame"

const GridLayout = WidthProvider(Responsive)

export function Canvas() {
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const updateLayouts = useStore((s) => s.updateLayouts)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  const activeView = views.find((v) => v.id === activeViewId)

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const handleLayoutChange = useCallback(
    (layout: LayoutItem[]) => {
      updateLayouts(activeViewId, layout)
    },
    [activeViewId, updateLayouts],
  )

  if (!activeView) return null

  const { widgets, layouts } = activeView
  const gridLayouts = layouts["lg"] ?? []

  // Empty state
  if (widgets.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <button
          className="w-14 h-14 rounded-full border-2 border-dashed border-border hover:border-accent text-text-muted hover:text-accent text-2xl transition-all flex items-center justify-center"
          onClick={() => setCatalogOpen(true)}
        >
          +
        </button>
        <span className="text-xs text-text-muted">Add your first widget</span>
        {catalogOpen && <WidgetCatalog onClose={() => setCatalogOpen(false)} />}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto p-2">
      {containerWidth > 0 && (
        <GridLayout
          className="layout"
          layouts={{ lg: gridLayouts }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: 12 }}
          rowHeight={36}
          width={containerWidth}
          onLayoutChange={handleLayoutChange}
          isDraggable
          isResizable
          draggableHandle=".widget-drag-handle"
          margin={[8, 8]}
          containerPadding={[0, 0]}
          compactType="vertical"
        >
          {widgets.map((widget) => {
            const WidgetComponent = widgetRegistry[widget.type]
            return (
              <div key={widget.id}>
                <WidgetFrame
                  widgetId={widget.id}
                  viewId={activeViewId}
                  type={widget.type}
                >
                  {WidgetComponent ? <WidgetComponent /> : <div>Unknown widget</div>}
                </WidgetFrame>
              </div>
            )
          })}
        </GridLayout>
      )}

      {/* Floating add button */}
      <button
        className="fixed bottom-5 right-5 w-10 h-10 rounded-full bg-accent hover:bg-accent-hover text-white text-lg shadow-lg transition-all flex items-center justify-center z-40"
        onClick={() => setCatalogOpen(true)}
        title="Add widget"
      >
        +
      </button>

      {catalogOpen && <WidgetCatalog onClose={() => setCatalogOpen(false)} />}
    </div>
  )
}
