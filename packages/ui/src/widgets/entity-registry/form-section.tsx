import type { JSX, ReactNode } from "react"

import { FIELD_LABEL, META_TEXT } from "./chrome"

/**
 * Form section / field chrome — Strategy, Sync metadata, Connectors, Freeze
 * windows, Routes, Schedules, Policy, … (~40 modal surfaces).
 *
 * Dialect: the modal (or tile) owns the one surface. Sections are titled
 * blocks separated by hairlines (see `.mia-form-section` in index.css). Field
 * groups are label + control — never a nested `mia-surface` around either.
 */

/** @deprecated Header is flush now; kept for any stray imports. */
export const FORM_SECTION_HEADER = "mb-3"

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
    <div className="min-w-0" role="group" aria-label={label}>
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
        "mia-form-section overflow-x-clip",
        emphasized ? "mia-form-section--emphasized" : "",
      ].filter(Boolean).join(" ")}
    >
      <header className="mb-3">
        <h4 className="text-sm font-semibold text-text">{title}</h4>
        {description ? <p className={`mt-0.5 ${META_TEXT}`}>{description}</p> : null}
      </header>
      <div className="min-w-0 space-y-3 [&>*]:shrink-0">{children}</div>
    </section>
  )
}
