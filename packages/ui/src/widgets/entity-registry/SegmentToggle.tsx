/**
 * Segmented toggle — unified track, no per-segment borders on hover.
 */

import type { JSX } from "react"
import { TAB_SEGMENT_TRACK } from "./chrome"

export interface SegmentToggleOption<T extends string> {
  value: T
  label: string
}

export interface SegmentToggleProps<T extends string> {
  value: T
  options: SegmentToggleOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}

export function SegmentToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentToggleProps<T>): JSX.Element {
  return (
    <div className={TAB_SEGMENT_TRACK} role="group" aria-label={ariaLabel}>
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
              "rounded-md px-3.5 py-2 text-sm font-medium leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              active
                ? "bg-elevated text-text shadow-sm"
                : "text-text-muted hover:bg-elevated/60 hover:text-text",
            ].join(" ")}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
