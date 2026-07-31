/**
 * Search field for modal browse strips — same height as Listbox sm / mia-control
 * (`--control-h` / h-9). Icon + input without overlap.
 */

import { Search, X } from "lucide-react"
import type { JSX } from "react"

export function ModalSearchField({
  value,
  onChange,
  placeholder = "Search…",
  "aria-label": ariaLabel = "Search",
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  "aria-label"?: string
}): JSX.Element {
  return (
    <div className="modal-search-field input flex shrink-0 items-center gap-2 pl-2.5 pr-1.5">
      <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-h-0 min-w-0 flex-1 border-0 bg-transparent py-0 text-sm leading-none outline-none focus:ring-0"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-elevated hover:text-text"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
