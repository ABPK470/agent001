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

export interface VirtualListHandle {
  /** Scroll so `index` enters the window (uses measured offsets when known). */
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end" | "auto"
      behavior?: "auto" | "smooth"
    },
  ) => void
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
    }),
    [virtualizer, items.length],
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
