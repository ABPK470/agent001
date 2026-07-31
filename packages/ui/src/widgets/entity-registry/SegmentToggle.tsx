/**
 * Segmented toggle — exclusive choices on a flat track (selection dialect).
 */

import type { JSX, ReactNode } from "react"
import { SELECT_ACTIVE, SELECT_FOCUS, SELECT_IDLE, SELECT_TRACK } from "../../lib/selection"

export interface SegmentToggleOption<T extends string> {
  value: T
  label: string
}

export interface SegmentToggleProps<T extends string> {
  value: T
  options: SegmentToggleOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** Extra controls in the same track (right side) — e.g. download. */
  trailing?: ReactNode
}

export function SegmentToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  trailing,
}: SegmentToggleProps<T>): JSX.Element {
  return (
    <div className={SELECT_TRACK} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={[
              "control-segment__btn inline-flex items-center rounded-md px-3.5 text-sm leading-none",
              SELECT_FOCUS,
              active ? SELECT_ACTIVE : SELECT_IDLE,
            ].join(" ")}
          >
            {option.label}
          </button>
        )
      })}
      {trailing}
    </div>
  )
}
