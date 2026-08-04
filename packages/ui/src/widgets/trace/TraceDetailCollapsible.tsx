/**
 * Collapsible detail section — card chrome, sticky header stays reachable while scrolling.
 */

import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"

export function TraceDetailCollapsible({
  label,
  meta,
  defaultOpen = true,
  sticky = true,
  variant = "section",
  actions,
  children,
}: {
  label: string
  meta?: string
  defaultOpen?: boolean
  /** Pin header while scrolling the detail panel. */
  sticky?: boolean
  /** `section` — top-level card; `nested` — row inside a parent body (e.g. tool list). */
  variant?: "section" | "nested"
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  const rootClass = [
    "trace-detail-collapsible",
    open ? "is-open" : "",
    sticky && variant === "section" ? "trace-detail-collapsible--sticky" : "",
    variant === "nested" ? "trace-detail-collapsible--nested" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <section className={rootClass}>
      <div className="trace-detail-collapsible__head-row">
        <button
          type="button"
          className="trace-detail-collapsible__head"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            size={14}
            className={`trace-detail-collapsible__chev${open ? " is-open" : ""}`}
            aria-hidden
          />
          <span className="trace-detail-collapsible__title">{label}</span>
        </button>
        {meta || actions ? (
          <div className="trace-detail-collapsible__head-meta">
            {meta ? <span className="trace-detail-collapsible__meta">{meta}</span> : null}
            {actions}
          </div>
        ) : null}
      </div>
      {open ? <div className="trace-detail-collapsible__body">{children}</div> : null}
    </section>
  )
}
