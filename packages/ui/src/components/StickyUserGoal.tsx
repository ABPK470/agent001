import type { ReactNode } from "react"

/** Clearance below the home-chat top fade overlay (`h-6`). */
export const STICKY_GOAL_HOME_TOP = "top-6"

/**
 * Pins a user goal bubble while scrolling through that turn's output.
 * Use `topClass` to sit below the home-chat top fade (see STICKY_GOAL_HOME_TOP).
 */
export function StickyUserGoal({
  align = "end",
  topClass = "top-0",
  children,
  className = "",
}: {
  align?: "start" | "end"
  topClass?: string
  children: ReactNode
  className?: string
}) {
  const rowAlign = align === "end" ? "justify-end" : "justify-start"

  return (
    <div className={`sticky ${topClass} z-30 flex w-full ${rowAlign} pt-1 pb-2 ${className}`}>
      {children}
    </div>
  )
}
