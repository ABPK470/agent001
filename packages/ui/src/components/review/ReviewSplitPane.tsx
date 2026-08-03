import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import {
  beginSplitPaneDrag,
  endSplitPaneDrag,
  moveSplitPaneDrag,
  type SplitPaneDragState,
} from "../../lib/split-pane-drag"

export function ReviewSplitPane({
  sidebar,
  main,
  ratio,
  onRatioChange,
  minRatio,
  maxRatio,
  shellRef,
  className = "",
}: {
  sidebar: ReactNode
  main: ReactNode
  ratio: number
  onRatioChange: (ratio: number) => void
  minRatio: number
  maxRatio: number
  shellRef?: React.RefObject<HTMLDivElement | null>
  className?: string
}) {
  const localShellRef = useRef<HTMLDivElement>(null)
  const splitShellRef = shellRef ?? localShellRef
  const splitDragRef = useRef<SplitPaneDragState | null>(null)

  function onSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = splitShellRef.current
    if (!shell) return
    splitDragRef.current = beginSplitPaneDrag(event, shell, ratio)
  }

  function onSplitPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current
    if (!drag) return
    onRatioChange(moveSplitPaneDrag(drag, event, minRatio, maxRatio))
  }

  function onSplitPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  function onSplitPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  return (
    <div className={`review-split-host relative min-h-0 flex-1 overflow-hidden ${className}`.trim()}>
      <div
        ref={splitShellRef}
        className="review-split-shell review-split-shell--resizable entity-registry-shell widget-split-shell grid h-full min-h-0 overflow-hidden"
        style={{
          gridTemplateColumns: `${Math.round(ratio * 1000) / 10}% 4px minmax(0, 1fr)`,
        }}
      >
        {sidebar}
        <div
          className="review-split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={Math.round(minRatio * 100)}
          aria-valuemax={Math.round(maxRatio * 100)}
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerUp}
          onPointerCancel={onSplitPointerCancel}
        />
        {main}
      </div>
    </div>
  )
}
