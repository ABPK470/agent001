import type { ReactNode } from "react"

/**
 * Keeps the user goal visible at the top of the chat scroll area while the
 * agent is still generating output for that run.
 */
export function StickyUserGoal({
  sticky,
  children,
  className = "",
}: {
  sticky: boolean
  children: ReactNode
  className?: string
}) {
  if (!sticky) {
    return <div className={className}>{children}</div>
  }

  return (
    <div
      className={`sticky top-0 z-20 -mx-1 px-1 pt-1 pb-3 bg-surface/95 backdrop-blur-sm supports-[backdrop-filter]:bg-surface/85 ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(to bottom, color-mix(in oklab, var(--color-surface) 96%, transparent) 0%, color-mix(in oklab, var(--color-surface) 82%, transparent) 78%, transparent 100%)",
      }}
    >
      {children}
    </div>
  )
}
