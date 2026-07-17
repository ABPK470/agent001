/**
 * Canvas — the blank canvas where widgets live.
 *
 * Uses react-grid-layout for drag/resize/snap grid behavior.
 * Renders the widgets for the active view.
 * Shows an "add widget" prompt when empty.
 */

import { LayoutGrid, Plus } from "lucide-react"
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Responsive } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
// NOTE: react-resizable/css/styles.css is NOT imported — its default SVG
// background-image bleeds through as grey dots on corners. All handle
// styling is in index.css instead.
import { useStore, WIDGET_DEFAULTS } from "../../state/store"
import type { LayoutItem } from "../../types"
import { widgetRegistry } from "../../widgets"
import { WidgetCatalog } from "./WidgetCatalog"
import { WidgetFrame } from "./WidgetFrame"

export interface CanvasHandle {
  openCatalog: () => void
}

import { forwardRef } from "react"

export const Canvas = forwardRef<CanvasHandle>(function Canvas(_props, ref) {
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const updateLayouts = useStore((s) => s.updateLayouts)
  const [catalogOpen, setCatalogOpen] = useState(false)

  useImperativeHandle(ref, () => ({ openCatalog: () => setCatalogOpen(true) }), [])
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  const activeView = views.find((v) => v.id === activeViewId)

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
        setContainerHeight(entry.contentRect.height)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // RGL's onLayoutChange MUST be wired — without it, RGL's internal
  // `setLayout` effect runs in an infinite loop because the parent's
  // `layouts` prop never catches up to RGL's internal state. The trick
  // for preserving user-intended sizes is in the store's `updateLayouts`
  // reducer: it discards RGL bookkeeping emissions where an item came
  // through smaller than its WIDGET_DEFAULTS minimum (typical of RGL's
  // default 1×1 generator during a synchronize pass), keeping the prior
  // stored size instead of clamping the bad value upward.
  const handleLayoutChange = useCallback(
    (layout: readonly LayoutItem[]) => {
      updateLayouts(activeViewId, [...layout])
    },
    [activeViewId, updateLayouts],
  )

  if (!activeView) return null

  const { widgets, layouts } = activeView
  const rawLayouts = layouts["lg"] ?? []

  // Enforce current WIDGET_DEFAULTS minW/minH/w/h on every layout item —
  // overrides stale values persisted from older sessions. Also clamps the
  // stored w/h so a widget saved narrower than its minimum renders at the
  // correct size immediately (react-grid-layout treats minW/minH as drag
  // constraints only, not render constraints).
  const gridLayouts = rawLayouts.map((item) => {
    const widget = widgets.find((w) => w.id === item.i)
    if (!widget) return item
    const defaults = WIDGET_DEFAULTS[widget.type]
    if (!defaults) return item
    return {
      ...item,
      minW: defaults.minW,
      minH: defaults.minH,
      w: Math.max(item.w, defaults.minW),
      h: Math.max(item.h, defaults.minH),
    }
  })

  // Dynamic row height: fill the entire container vertically
  const MARGIN = 8
  const totalRows = gridLayouts.length > 0
    ? Math.max(...gridLayouts.map((item) => item.y + item.h))
    : 1
  const dynamicRowHeight = containerHeight > 0 && totalRows > 0
    ? Math.max(20, (containerHeight - (totalRows + 1) * MARGIN) / totalRows)
    : 36

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden p-2">
      {/* Empty state */}
      {widgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-5">
          <LayoutGrid size={48} className="text-text-faint" strokeWidth={1.5} />
          <div className="text-center">
            <p className="text-base text-text-secondary mb-1">Your canvas is empty</p>
            <p className="text-sm text-text-muted">Add widgets to build your dashboard</p>
          </div>
          <button
            className="flex items-center gap-2 px-6 py-2.5 text-text-secondary hover:text-text text-sm border border-border hover:border-text-secondary/25 rounded-xl transition-colors"
            onClick={() => setCatalogOpen(true)}
          >
            <Plus size={16} />
            Add Widget
          </button>
        </div>
      ) : containerWidth > 0 ? (
        <Responsive
          className="layout"
          layouts={{ lg: gridLayouts }}
          breakpoints={{ lg: 0 }}
          cols={{ lg: 12 }}
          rowHeight={dynamicRowHeight}
          width={containerWidth}
          onLayoutChange={handleLayoutChange}
          dragConfig={{
            handle: ".widget-drag-handle",
            cancel: ".widget-controls,.widget-content",
          }}
          resizeConfig={{
            handles: ["se", "sw", "ne", "nw", "e", "w", "s", "n"],
          }}
          margin={[8, 8]}
          containerPadding={[0, 0]}
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
        </Responsive>
      ) : null}

      {catalogOpen && <WidgetCatalog onClose={() => setCatalogOpen(false)} />}
    </div>
  )
})
