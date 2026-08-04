/**
 * Collapsible detail section — flat accordion row (trace detail dialect).
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
  sticky?: boolean
  variant?: "section" | "nested"
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  const rootClass = [
    "trace-detail-section",
    "trace-detail-section--accordion",
    sticky && variant === "section" ? "trace-detail-section--sticky" : "",
    variant === "nested" ? "trace-detail-section--nested" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <section className={rootClass}>
      <div className="trace-detail-accordion-bar">
        <button
          type="button"
          className="trace-detail-accordion"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            size={14}
            className={`trace-detail-accordion__chev${open ? " is-open" : ""}`}
            aria-hidden
          />
          <span className="trace-detail-accordion__label">{label}</span>
        </button>
        {meta || actions ? (
          <div className="trace-detail-accordion__rail">
            {meta ? <span className="trace-detail-accordion__meta">{meta}</span> : null}
            {actions}
          </div>
        ) : null}
      </div>
      {open ? <div className="trace-detail-accordion__body">{children}</div> : null}
    </section>
  )
}
