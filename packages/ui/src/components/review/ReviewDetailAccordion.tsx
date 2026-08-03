import { ChevronRight } from "lucide-react"
import type { JSX, ReactNode } from "react"

export function ReviewDetailAccordion({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <section className="review-detail-section review-detail-section--accordion">
      <button
        type="button"
        className="review-detail-accordion"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight
          size={14}
          className={`review-detail-accordion__chev${open ? " is-open" : ""}`}
          aria-hidden
        />
        <span className="review-detail-accordion__label">{label}</span>
      </button>
      {open ? <div className="review-detail-accordion__body">{children}</div> : null}
    </section>
  )
}
