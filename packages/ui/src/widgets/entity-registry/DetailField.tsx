import type { JSX, ReactNode } from "react"

/** Read-only label + value cell for overview modals. */
export function DetailField({
  label,
  value,
  mono,
  span = 1,
}: {
  label: string
  value: ReactNode
  mono?: boolean
  /** Grid column span when the modal-detail container is wide enough */
  span?: 1 | 2
}): JSX.Element {
  return (
    <div className={span === 2 ? "modal-detail-field--span-2" : undefined}>
      <div className="modal-detail-field">
        <span className="modal-detail-field__label">{label}</span>
        <div className={`modal-detail-field__value${mono ? " modal-detail-field__value--mono" : ""}`}>
          {value ?? <span className="text-text-faint">—</span>}
        </div>
      </div>
    </div>
  )
}

export function DetailGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="modal-detail-grid">{children}</div>
}

export function DetailSection({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="modal-detail-section">
      {title && <h3 className="modal-detail-section__title">{title}</h3>}
      {children}
    </section>
  )
}
