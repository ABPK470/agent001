/**
 * Searchable pick — filterable dropdown that also accepts custom typed values.
 */

import { Check, ChevronDown } from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react"
import {
  claimPopoverOpen,
  registerPopoverInstance,
  releasePopoverOpen,
} from "../lib/popover-dismiss"

export interface SearchablePickOption {
  value: string
  label: string
  hint?: string
}

export function SearchablePick({
  value,
  options,
  onChange,
  placeholder = "Type or pick…",
  ariaLabel,
  disabled,
  className = "",
  size = "md",
}: {
  value: string
  options: readonly SearchablePickOption[]
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
  /** Match Listbox / DateField filter-bar footprint when `"sm"`. */
  size?: "sm" | "md"
}): JSX.Element {
  const instanceId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [...options]
    return options.filter(
      (option) =>
        option.value.toLowerCase().includes(q) ||
        option.label.toLowerCase().includes(q) ||
        option.hint?.toLowerCase().includes(q),
    )
  }, [options, query])

  const closePopover = useCallback((): void => {
    setOpen(false)
    releasePopoverOpen(instanceId)
  }, [instanceId])

  const openPopover = useCallback((): void => {
    claimPopoverOpen(instanceId)
    setOpen(true)
  }, [instanceId])

  useEffect(() => registerPopoverInstance(instanceId, closePopover), [instanceId, closePopover])

  useEffect(() => {
    if (!open) return
    function onDocClick(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) closePopover()
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open, closePopover])

  function commit(next: string): void {
    const trimmed = next.trim()
    setQuery(trimmed)
    onChange(trimmed)
    closePopover()
  }

  const sizeCls = size === "sm" ? "px-2.5 py-1.5 text-sm" : "px-3 py-2 text-sm"

  return (
    <div ref={rootRef} className="relative w-full">
      <div
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          "listbox-control group flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-base text-left text-text transition-colors",
          "hover:bg-elevated hover:border-border-focus focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40",
          disabled ? "cursor-not-allowed opacity-40" : "",
          sizeCls,
          className,
        ].join(" ")}
      >
        <input
          ref={inputRef}
          value={query}
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className={[
            "min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-text outline-none placeholder:text-text-muted disabled:cursor-not-allowed",
            size === "sm" ? "" : "font-mono",
          ].join(" ")}
          onChange={(e) => {
            setQuery(e.target.value)
            if (!open) openPopover()
            else claimPopoverOpen(instanceId)
          }}
          onFocus={() => {
            if (!open) openPopover()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit(query)
            }
            if (e.key === "Escape") closePopover()
          }}
        />
        <button
          type="button"
          disabled={disabled}
          className="flex shrink-0 items-center text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed"
          aria-label="Show options"
          onClick={() => {
            if (open) closePopover()
            else openPopover()
            inputRef.current?.focus()
          }}
        >
          <ChevronDown
            size={14}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open && !disabled && (
        <div className="listbox-popover absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-56 overflow-auto rounded-md">
          {filtered.length === 0 ? (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-text-muted hover:bg-elevated"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(query)}
            >
              Use: <span className="font-mono text-text">{query.trim() || "…"}</span>
            </button>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value || option.label}
                type="button"
                className="listbox-popover__option flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-elevated"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(option.value)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text">{option.label}</span>
                  {option.hint && <span className="mt-0.5 block text-xs text-text-muted">{option.hint}</span>}
                </span>
                {option.value === value && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
