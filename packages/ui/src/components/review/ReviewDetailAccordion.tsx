import { ChevronRight } from "lucide-react"
import { useRef, type JSX, type ReactNode } from "react"
import { useRegisterDetailSection } from "./DetailSectionContext"

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
  const headerRef = useRef<HTMLButtonElement>(null)
  const { active, activate } = useRegisterDetailSection({
    open,
    setOpen: (next) => {
      if (next !== open) onToggle()
    },
    headerRef,
  })

  return (
    <section className="review-detail-section review-detail-section--accordion">
      <button
        ref={headerRef}
        type="button"
        className={`review-detail-accordion${active ? " is-section-focused" : ""}`}
        aria-expanded={open}
        onClick={() => {
          activate()
          onToggle()
        }}
        onFocus={activate}
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
