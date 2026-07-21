/**
 * VS Code / Cursor sticky-scroll pin overlay.
 *
 * Clones the ancestor chain of the focus line. Never uses position:sticky
 * on in-flow card headers (overflow/radius fight).
 */

import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  OUTLINE_STICKY_ROW_H,
  computePinnedScopeIds,
  samePinnedIds,
} from "../../lib/events/pin"

export type StickyPinRow = {
  id: string
  depth: number
  /** Rendered chrome — same dialect as in-flow header. */
  content: ReactNode
  onJump?: () => void
  onToggle?: () => void
}

export function StickyPinOverlay({
  scrollRef,
  rows,
  rowHeight = OUTLINE_STICKY_ROW_H,
  className = "",
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  /** Map pinned scope id → row chrome (caller builds from open outline). */
  rows: StickyPinRow[]
  rowHeight?: number
  className?: string
}) {
  const [pinnedIds, setPinnedIds] = useState<string[]>([])
  const pinnedRef = useRef<string[]>([])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function refresh() {
      const host = scrollRef.current
      if (!host) return
      const next = computePinnedScopeIds(host)
      if (samePinnedIds(pinnedRef.current, next)) return
      pinnedRef.current = next
      setPinnedIds(next)
    }

    refresh()
    el.addEventListener("scroll", refresh, { passive: true })
    const ro = new ResizeObserver(refresh)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", refresh)
      ro.disconnect()
    }
  }, [scrollRef])

  const byId = new Map(rows.map((r) => [r.id, r]))
  const visible = pinnedIds.map((id) => byId.get(id)).filter(Boolean) as StickyPinRow[]

  if (visible.length === 0) return null

  return (
    <div
      className={`outline-pin${className ? ` ${className}` : ""}`}
      style={{ ["--outline-pin-row-h" as string]: `${rowHeight}px` }}
      aria-hidden={false}
      role="navigation"
      aria-label="Pinned outline scopes"
    >
      {visible.map((row) => (
        <div
          key={row.id}
          className="outline-pin__row"
          data-outline-pin={row.id}
          data-outline-depth={String(row.depth)}
        >
          {row.onJump || row.onToggle ? (
            <button
              type="button"
              className="outline-pin__hit"
              onClick={() => {
                if (row.onToggle) row.onToggle()
                else row.onJump?.()
              }}
            >
              {row.content}
            </button>
          ) : (
            <div className="outline-pin__hit">{row.content}</div>
          )}
        </div>
      ))}
    </div>
  )
}
