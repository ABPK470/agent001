import type { ReactNode } from "react"

/**
 * Pins the user's goal to the top of the chat scrollport while the agent is
 * still working on that run. Must be a direct child of the run block that
 * also contains the (long) assistant output — otherwise CSS sticky cannot
 * span the scroll range.
 */
export function StickyUserGoal({
  sticky,
  align = "end",
  children,
  className = "",
}: {
  sticky: boolean
  align?: "start" | "end"
  children: ReactNode
  className?: string
}) {
  const rowAlign = align === "end" ? "justify-end" : "justify-start"

  if (!sticky) {
    return <div className={`flex w-full ${rowAlign} ${className}`}>{children}</div>
  }

  return (
    <div
      className={`sticky top-0 z-30 flex w-full ${rowAlign} border-b border-border-subtle/50 bg-surface py-2 shadow-[0_6px_16px_-8px_rgba(0,0,0,0.45)] ${className}`}
    >
      {children}
    </div>
  )
}
