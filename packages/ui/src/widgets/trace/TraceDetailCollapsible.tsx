/**
 * Collapsible detail section — flat accordion row (trace detail dialect).
 *
 * Sticky only while open: peer collapsed rows must not all pin at top:0
 * (that paints seals/gaps and stacks headers on each other).
 */

import { ChevronRight } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import {
  useRegisterDetailSection,
  type DetailSectionPeekBinding,
} from "../../components/review/DetailSectionContext"

type AccordionActions =
  | ReactNode
  | ((state: { open: boolean }) => ReactNode)

export function TraceDetailCollapsible({
  label,
  meta,
  defaultOpen = true,
  sticky = true,
  variant = "section",
  actions,
  peek,
  children,
}: {
  label: string
  meta?: string
  defaultOpen?: boolean
  sticky?: boolean
  variant?: "section" | "nested"
  actions?: AccordionActions
  /** Nested More/Less — ←→ peels section then peek. */
  peek?: DetailSectionPeekBinding | null
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const headerRef = useRef<HTMLButtonElement>(null)
  const { active, activate } = useRegisterDetailSection({
    open,
    setOpen,
    headerRef,
    peek,
  })

  const rootClass = [
    "trace-detail-section",
    "trace-detail-section--accordion",
    sticky && open && variant === "section" ? "trace-detail-section--sticky" : "",
    variant === "nested" ? "trace-detail-section--nested" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const rail = typeof actions === "function" ? actions({ open }) : actions

  return (
    <section className={rootClass}>
      <div className="trace-detail-accordion-bar">
        <button
          ref={headerRef}
          type="button"
          className={`trace-detail-accordion${active ? " is-section-focused" : ""}`}
          aria-expanded={open}
          onClick={() => {
            activate()
            setOpen((value) => !value)
          }}
          onFocus={activate}
        >
          <ChevronRight
            size={14}
            className={`trace-detail-accordion__chev${open ? " is-open" : ""}`}
            aria-hidden
          />
          <span className="trace-detail-accordion__label">{label}</span>
        </button>
        {meta || rail ? (
          <div className="trace-detail-accordion__rail">
            {meta ? <span className="trace-detail-accordion__meta">{meta}</span> : null}
            {rail}
          </div>
        ) : null}
      </div>
      {open ? <div className="trace-detail-accordion__body">{children}</div> : null}
    </section>
  )
}
