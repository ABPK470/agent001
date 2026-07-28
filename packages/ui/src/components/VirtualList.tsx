/**
 * Single virtualization dialect for unbounded widget lists.
 * Widgets import this — never @tanstack/react-virtual directly.
 */

import { useVirtualizer } from "@tanstack/react-virtual"
import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"

export interface VirtualListProps<T> {
  items: readonly T[]
  /** Estimated row height in px (dynamic measure refines). */
  estimateSize: (index: number) => number
  /** Scroll parent — when omitted, the list owns an overflow container. */
  scrollRef?: RefObject<HTMLElement | null>
  className?: string
  style?: CSSProperties
  overscan?: number
  getItemKey?: (index: number, item: T) => string | number
  renderItem: (args: { item: T; index: number }) => ReactNode
  /** Rendered after the virtual window (e.g. load-more sentinel). */
  footer?: ReactNode
}

export function VirtualList<T>({
  items,
  estimateSize,
  scrollRef: externalScrollRef,
  className,
  style,
  overscan = 8,
  getItemKey,
  renderItem,
  footer,
}: VirtualListProps<T>) {
  const internalRef = useRef<HTMLDivElement>(null)
  const parentRef = (externalScrollRef ?? internalRef) as RefObject<HTMLElement | null>
  const ownsScroller = !externalScrollRef

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan,
    getItemKey: getItemKey
      ? (index) => getItemKey(index, items[index]!)
      : undefined,
  })

  const virtualItems = virtualizer.getVirtualItems()

  useEffect(() => {
    virtualizer.measure()
  }, [items.length, virtualizer])

  const content = (
    <div
      className="relative w-full"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualItems.map((virtualRow) => (
        <div
          key={virtualRow.key}
          data-index={virtualRow.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualRow.start}px)`,
          }}
        >
          {renderItem({ item: items[virtualRow.index]!, index: virtualRow.index })}
        </div>
      ))}
      {footer ? (
        <div
          className="absolute left-0 w-full"
          style={{ top: virtualizer.getTotalSize() }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  )

  if (ownsScroller) {
    return (
      <div
        ref={internalRef}
        className={className}
        style={{ overflow: "auto", ...style }}
      >
        {content}
      </div>
    )
  }

  return (
    <div className={className} style={style}>
      {content}
    </div>
  )
}
