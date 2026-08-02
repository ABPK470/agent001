/**
 * Flat governance panel — border shell, no floating card fill.
 */

import type { ReactNode } from "react"

export function PolicyPanel({
  title,
  icon,
  children,
  danger = false,
  collapsible,
  open,
  onToggle,
  trailing,
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
  danger?: boolean
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
  trailing?: ReactNode
}) {
  const shellClass = [
    "rounded-lg border border-border-subtle overflow-hidden",
    danger ? "border-l-[3px] border-l-error" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const headerInner = (
    <>
      {icon ? <span className="shrink-0 text-text-faint">{icon}</span> : null}
      <span className="text-sm font-semibold text-text">{title}</span>
      {trailing ? <span className="ml-auto text-sm text-text-muted">{trailing}</span> : null}
    </>
  )

  return (
    <section className={shellClass}>
      {collapsible ? (
        <button
          type="button"
          className="flex w-full items-center gap-2.5 border-b border-border-subtle px-4 py-3 text-left transition-colors hover:bg-[var(--hover-fill)]"
          onClick={onToggle}
          aria-expanded={open}
        >
          {headerInner}
        </button>
      ) : (
        <header className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          {headerInner}
        </header>
      )}
      {(!collapsible || open) ? (
        <div className="px-4 py-3">{children}</div>
      ) : null}
    </section>
  )
}
