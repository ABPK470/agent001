import type { ReactNode } from "react"

/**
 * Pins a user goal bubble to the top of the chat scrollport while the user
 * scrolls through that turn's assistant output (during and after the run).
 *
 * Must be a direct child of the turn block that contains all response content
 * below the goal.
 */
export function StickyUserGoal({
  align = "end",
  children,
  className = "",
}: {
  align?: "start" | "end"
  children: ReactNode
  className?: string
}) {
  const rowAlign = align === "end" ? "justify-end" : "justify-start"

  return (
    <div className={`sticky top-0 z-20 flex w-full ${rowAlign} pt-1 pb-2 ${className}`}>
      {children}
    </div>
  )
}
