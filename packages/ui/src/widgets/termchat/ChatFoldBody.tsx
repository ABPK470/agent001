/**
 * Smooth open/collapse for chat tool chips — same 0fr→1fr dialect as
 * SetupHintStrip / thread-nav. Prefer over conditional unmount so previous
 * chips ease shut when the latest opens (no layout snap).
 */

import type { ReactNode } from "react"

const FOLD_MOTION =
  "transition-[grid-template-rows] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"

export function ChatFoldBody({
  open,
  children,
  className = "",
}: {
  open: boolean
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div
      className={["grid", FOLD_MOTION, open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"].join(" ")}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  )
}
