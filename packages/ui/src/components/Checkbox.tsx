/**
 * Platform checkbox — one painted control everywhere.
 * Never use raw `<input type="checkbox">` in product UI; lint:arch enforces this.
 */

import { Check } from "lucide-react"
import type { JSX } from "react"

export function Checkbox({
  checked,
  onChange,
  disabled,
  id,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}): JSX.Element {
  return (
    <span
      className={[
        "mia-checkbox relative shrink-0",
        checked ? "mia-checkbox--on" : "",
        disabled ? "mia-checkbox--disabled" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        id={id}
        type="checkbox"
        className="mia-checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onChange={(e) => onChange(e.target.checked)}
      />
      {checked ? (
        <Check className="h-3 w-3 text-text-on-accent" strokeWidth={3} aria-hidden />
      ) : null}
    </span>
  )
}

export type LabeledCheckboxLayout = "plain" | "card"

/** Checkbox + label. `card` = bordered form row; `plain` = box beside text. */
export function LabeledCheckbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
  layout = "plain",
  className = "",
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  layout?: LabeledCheckboxLayout
  className?: string
}): JSX.Element {
  const root =
    layout === "card"
      ? [
          "mia-checkbox-field mia-checkbox-field--card flex h-auto min-h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border-subtle bg-base/30 px-3 py-2 text-sm text-text",
          disabled ? "pointer-events-none opacity-50" : "hover:bg-elevated/50",
          className,
        ]
      : [
          "mia-checkbox-field flex cursor-pointer gap-2 text-sm text-text",
          hint ? "items-start" : "items-center",
          disabled ? "pointer-events-none opacity-50" : "",
          className,
        ]

  return (
    <label className={root.filter(Boolean).join(" ")}>
      <Checkbox
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className={layout === "plain" && hint ? "mt-0.5" : undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-text">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-snug text-text-muted">{hint}</span> : null}
      </span>
    </label>
  )
}
