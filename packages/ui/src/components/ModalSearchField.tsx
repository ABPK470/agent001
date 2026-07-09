/**
 * Search field for modal bodies — icon + input without overlap.
 */

import { Search, X } from "lucide-react"

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
}) {
  return (
    <div className="input flex shrink-0 items-center gap-2 py-0 pl-2.5 pr-2">
      <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm outline-none focus:ring-0"
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
      ) : (
        <span className="h-6 w-6 shrink-0" aria-hidden />
      )}
    </div>
  )
}
