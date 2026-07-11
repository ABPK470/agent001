/**
 * Two-option toggle for registry menus — original size, entity-rail active fill.
 */

import type { JSX } from "react"

export interface RegistryModeToggleOption<T extends string> {
  value: T
  label: string
}

export interface RegistryModeToggleProps<T extends string> {
  value: T
  options: RegistryModeToggleOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
}

export function RegistryModeToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: RegistryModeToggleProps<T>): JSX.Element {
  return (
    <div
      className="flex gap-0.5 rounded-md border border-border-subtle p-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={[
              "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              active
                ? "registry-mode-toggle__btn--active shadow-sm"
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
