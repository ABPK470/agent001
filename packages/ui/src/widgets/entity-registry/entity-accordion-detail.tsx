/**
 * Shared accordion drawer — meta grid + section headings (Overview + Tables).
 */

import type { JSX, ReactNode } from "react"

export function AccordionMetaField({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}): JSX.Element {
  return (
    <div className="entity-accordion-meta-field">
      <span className="entity-accordion-meta-field__label">{label}</span>
      <span
        className={`entity-accordion-meta-field__value${mono ? " entity-accordion-meta-field__value--mono" : ""}`}
      >
        {value ?? "—"}
      </span>
    </div>
  )
}

export function AccordionBoolPill({ value }: { value: boolean | null | undefined }): JSX.Element {
  if (value === true) {
    return <span className="entity-accordion-pill entity-accordion-pill--yes">Yes</span>
  }
  if (value === false) {
    return <span className="entity-accordion-pill entity-accordion-pill--no">No</span>
  }
  return <span className="text-text-faint">—</span>
}

export function AccordionDetailBlock({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="entity-accordion-detail__block">
      {title ? <h4 className="entity-accordion-detail__heading">{title}</h4> : null}
      {children}
    </div>
  )
}

export function AccordionMetaGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="entity-accordion-meta-grid">{children}</div>
}
