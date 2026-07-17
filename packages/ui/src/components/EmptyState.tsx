/**
 * EmptyState — canonical empty surface for widgets and modals.
 *
 * Centered icon + short message (and optional action), filling the content
 * area both horizontally and vertically. Match Sync's idle state.
 */

import type { LucideIcon } from "lucide-react"
import type { JSX, ReactNode } from "react"

export function EmptyState({
  icon: Icon,
  message,
  detail,
  action,
  className = "",
}: {
  icon: LucideIcon
  message: ReactNode
  detail?: ReactNode
  action?: ReactNode
  /** Extra classes on the outer shell (e.g. background tint). */
  className?: string
}): JSX.Element {
  return (
    <div
      className={[
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      ].join(" ")}
    >
      <Icon size={20} className="shrink-0 text-text-muted opacity-40" aria-hidden />
      <div className="text-sm text-text-muted">{message}</div>
      {detail != null && detail !== false && (
        <div className="max-w-md text-xs text-text-muted/80">{detail}</div>
      )}
      {action != null && <div className="mt-0.5">{action}</div>}
    </div>
  )
}
