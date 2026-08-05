/**
 * Single virtualization dialect for unbounded widget lists.
 * Widgets import this — never @tanstack/react-virtual directly.
 *
 * Rows use `top` offsets — never `transform`. A transform on the row
 * creates a containing block and breaks CSS `position: sticky` inside
 * (chat user-goal pins, pipeline sticky headers). Absolute + top still
 * virtualizes; sticky sticks to the scroll host as designed.
 */

import { useVirtualizer } from "@tanstack/react-virtual"
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import {
  captureVirtualScrollAnchor,
  scrollTopForVirtualAnchor,
  type VirtualListScrollAnchor,
} from "../lib/virtual-list-anchor"

export type { VirtualListScrollAnchor }

export interface VirtualListHandle {
  /** Scroll so `index` enters the window (uses measured offsets when known). */
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto"
      behavior?: "auto" | "smooth"
    },
  ) => void
  /**
   * Inspect anchor — row index + offset inside that row (not raw scrollTop).
   * Survives VirtualList remasure when a tool above collapses.
   */
  captureScrollAnchor: () => VirtualListScrollAnchor | null
  /** Re-apply a captured anchor after layout/remasure. */
  restoreScrollAnchor: (anchor: VirtualListScrollAnchor) => void
}

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
  /**
   * When false, row resize never nudges scrollTop.
   * Trace folds own scroll via pin-band compensation + header park; chat turns
   * own live follow via useStickToBottomScroll — TanStack resize correction
   * otherwise flinches the whole scrollport while tools grow mid-run.
   */
  adjustScrollOnResize?: boolean
}

function VirtualListInner<T>(
  {
    items,
    estimateSize,
    scrollRef: externalScrollRef,
    className,
    style,
    overscan = 8,
    getItemKey,
    renderItem,
    footer,
    adjustScrollOnResize = true,
  }: VirtualListProps<T>,
  ref: ForwardedRef<VirtualListHandle>,
) {
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
    shouldAdjustScrollPositionOnItemSizeChange: adjustScrollOnResize
      ? undefined
      : () => false,
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index, options) {
        if (index < 0 || index >= items.length) return
        virtualizer.scrollToIndex(index, {
          align: options?.align ?? "start",
          behavior: options?.behavior ?? "auto",
        })
      },
      captureScrollAnchor() {
        const host = parentRef.current
        if (!host || items.length === 0) return null
        return captureVirtualScrollAnchor(
          host.scrollTop,
          virtualizer.getVirtualItems().map((row) => ({
            index: row.index,
            start: row.start,
            size: row.size,
          })),
        )
      },
      restoreScrollAnchor(anchor) {
        if (anchor.index < 0 || anchor.index >= items.length) return
        const host = parentRef.current
        if (!host) return
        const offsetInfo = virtualizer.getOffsetForIndex(anchor.index, "start")
        const itemStart = offsetInfo?.[0]
        const nextTop = scrollTopForVirtualAnchor(anchor, itemStart)
        if (nextTop == null) return
        virtualizer.scrollToOffset(nextTop, { align: "start", behavior: "auto" })
      },
    }),
    [virtualizer, items.length, parentRef],
  )

  const virtualItems = virtualizer.getVirtualItems()

  // Do NOT call virtualizer.measure() when items.length changes — that clears
  // TanStack's itemSizeCache and collapses every row back to estimateSize
  // (chat turns ~160px). Absolute rows then overlap and totalSize stops growing
  // until remount. Keys (getItemKey) keep measured sizes across appends;
  // measureElement + ResizeObserver refine live growth.

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
            top: virtualRow.start,
            left: 0,
            width: "100%",
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

/** Generic forwardRef wrapper — call sites keep the same JSX props. */
export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<VirtualListHandle> },
) => ReactElement
