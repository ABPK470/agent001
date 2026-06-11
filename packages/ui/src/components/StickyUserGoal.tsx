import type { ReactNode } from "react"

/** Sit just below the home transcript top fade (~14px). */
export const STICKY_GOAL_HOME_TOP = "top-3.5"

/**
 * Pins a user goal bubble while scrolling through that turn's output.
 * Use `topClass` to sit below the home-chat top fade (see STICKY_GOAL_HOME_TOP).
 */
export function StickyUserGoal({
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
}) {
  const rowAlign = align === "end" ? "justify-end" : "justify-start"
  const positionClass = pinned ? `sticky ${topClass} z-30` : "relative"

  return (
    <div className={`${positionClass} flex w-full ${rowAlign} pt-1 pb-2 ${className}`}>
      {children}
    </div>
  )
}
