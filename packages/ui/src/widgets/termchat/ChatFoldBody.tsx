/**
 * Smooth open/collapse for chat tool chips — same 0fr→1fr dialect as
 * SetupHintStrip / thread-nav. Prefer over conditional unmount so previous
 * chips ease shut when the latest opens (no layout snap).
 */

import type { ReactNode } from "react"

const FOLD_MOTION =
  "transition-[grid-template-rows] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"

/**
 * Smooth open/collapse for chat tool chips.
 * Pass `animated={false}` for live auto open/close — height transitions
 * fight stick-to-bottom and read as whole-page shake.
 */
export function ChatFoldBody({
  open,
  animated = true,
  children,
  className = "",
}: {
  open: boolean
  /** When false, open/close is instant (no layout animation). */
  animated?: boolean
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div
      className={[
        "grid",
        animated ? FOLD_MOTION : "",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={className} data-chat-expand-body="">
          {children}
        </div>
      </div>
    </div>
  )
}
