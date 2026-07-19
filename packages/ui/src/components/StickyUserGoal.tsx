import { forwardRef, type ReactNode } from "react"

/** Sit just below the home transcript top fade (~14px). */
export const STICKY_GOAL_HOME_TOP = "top-3.5"
/** Must match `top-3.5` — used by stuck-pin detection in TermChat. */
export const STICKY_GOAL_HOME_OFFSET_PX = 14

/**
 * Pins a user goal bubble while scrolling through that turn's output.
 * Use `topClass` to sit below the home-chat top fade (see STICKY_GOAL_HOME_TOP).
 */
export const StickyUserGoal = forwardRef(function StickyUserGoal({
  align = "end",
  topClass = "top-0",
  pinned = true,
  children,
  className = "",
}: {
  align?: "start" | "end"
  topClass?: string
  /** When false, the goal stays in normal document flow (unpinned). */
  pinned?: boolean
  children: ReactNode
  className?: string
}, ref: React.Ref<HTMLDivElement>) {
  const rowAlign = align === "end" ? "justify-end" : "justify-start"
  const positionClass = pinned ? `sticky ${topClass} z-30` : "relative"

  return (
    <div ref={ref} className={`${positionClass} flex w-full ${rowAlign} ${className}`}>
      {children}
    </div>
  )
})
