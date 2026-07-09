import type { JSX, ReactNode } from "react"

import { FIELD_LABEL, META_TEXT } from "./chrome"

export const FORM_SECTION_HEADER = "border-b border-border-subtle bg-accent/5 px-3 py-2.5"

export function FormFieldGroup({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="rounded-md border border-border-subtle/70 bg-base/40 p-2.5">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>{label}</span>
        {children}
        {hint ? <span className={`normal-case leading-snug ${META_TEXT}`}>{hint}</span> : null}
      </label>
    </div>
  )
}

export function FormSectionCard({
  title,
  description,
  emphasized = false,
  children,
}: {
  title: string
  description?: string
  emphasized?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={[
        "overflow-hidden rounded-lg border border-border-subtle bg-elevated/50",
        emphasized ? "shadow-sm ring-1 ring-inset ring-accent/10" : "",
      ].join(" ")}
    >
      <header className={FORM_SECTION_HEADER}>
        <h4 className="text-sm font-semibold text-text">{title}</h4>
        {description ? <p className={`mt-0.5 ${META_TEXT}`}>{description}</p> : null}
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  )
}
