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
  // Group — not <label>. Listbox/DateField/buttons are not labelable composites;
  // wrapping them in <label> is invalid HTML and has blown modal flex layouts
  // when sibling controls (e.g. Restricted checklist) mount beside a Listbox.
  return (
    <div
      className="min-w-0 rounded-md border border-border-subtle/70 bg-base/40 p-2.5"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>{label}</span>
        <div className="min-w-0">{children}</div>
        {hint ? <span className={`normal-case leading-snug ${META_TEXT}`}>{hint}</span> : null}
      </div>
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
        // Clip corner radius only — do not create a nested scrollport that can
        // swallow focus-scroll when expanding sections (Restricted checklist).
        "overflow-x-clip rounded-lg border border-border-subtle bg-elevated/50",
        emphasized ? "shadow-sm ring-1 ring-inset ring-accent/10" : "",
      ].join(" ")}
    >
      <header className={FORM_SECTION_HEADER}>
        <h4 className="text-sm font-semibold text-text">{title}</h4>
        {description ? <p className={`mt-0.5 ${META_TEXT}`}>{description}</p> : null}
      </header>
      <div className="min-w-0 space-y-3 p-3">{children}</div>
    </section>
  )
}
