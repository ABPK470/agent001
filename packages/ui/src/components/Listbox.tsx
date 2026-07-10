/**
 * Listbox — minimal, accessible, theme-aware dropdown with filter.
 * Replaces native <select> for a consistent platform feel.
 */

import { Check, ChevronDown, Search } from "lucide-react"
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react"
import { createPortal } from "react-dom"
import { popoverZIndex } from "../lib/modal-stack"
import {
  claimPopoverOpen,
  registerPopoverInstance,
  releasePopoverOpen,
} from "../lib/popover-dismiss"

export interface ListboxOption<T extends string> {
  value: T
  label: string
  hint?: string | null
  /** Inline color dot rendered before the label (any CSS color). */
  dot?: string | null
  disabled?: boolean
}

export interface ListboxProps<T extends string> {
  value: T
  options: ListboxOption<T>[]
  onChange: (v: T) => void
  placeholder?: string
  /** Header label shown above the trigger inside the button (small caption). */
  caption?: string
  /** Visual size. */
  size?: "sm" | "md" | "lg"
  /** Emphasis variant. */
  variant?: "default" | "ghost" | "card" | "segment"
  className?: string
  ariaLabel?: string
  disabled?: boolean
  /** Placeholder for the in-popover filter field. */
  searchPlaceholder?: string
}

const SEARCH_ROW_HEIGHT = 40
const OPTION_ROW_HEIGHT = 44

function measurePopoverWidth(
  triggerWidth: number,
  left: number,
  options: ListboxOption<string>[],
): { minWidth: number; maxWidth: number } {
  const viewportPad = 16
  const maxWidth = Math.min(420, window.innerWidth - left - viewportPad)
  const longest = options.reduce((max, option) => {
    const len = option.label.length + (option.hint ? Math.min(option.hint.length, 48) : 0)
    return Math.max(max, len)
  }, 0)
  const contentGuess = Math.min(420, Math.max(220, longest * 7))
  const minWidth = Math.max(Math.round(triggerWidth), Math.min(contentGuess, maxWidth))
  return { minWidth, maxWidth: Math.max(minWidth, maxWidth) }
}

function filterListboxOptions<T extends string>(
  options: ListboxOption<T>[],
  query: string,
): ListboxOption<T>[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(q) ||
      option.value.toLowerCase().includes(q) ||
      option.hint?.toLowerCase().includes(q),
  )
}

export function Listbox<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  caption,
  size = "md",
  variant = "default",
  className = "",
  ariaLabel,
  disabled,
  searchPlaceholder = "Filter…",
}: ListboxProps<T>): JSX.Element {
  const instanceId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIdx, setActiveIdx] = useState(-1)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [popPos, setPopPos] = useState<{
    top: number
    left: number
    minWidth: number
    maxWidth: number
    placement: "below" | "above"
  } | null>(null)

  const selected = options.find((o) => o.value === value) ?? null
  const showDots = options.some((o) => o.dot)
  const filteredOptions = useMemo(() => filterListboxOptions(options, query), [options, query])

  const updatePopPos = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const { minWidth, maxWidth } = measurePopoverWidth(r.width, r.left, options)
    const listHeight = Math.min(filteredOptions.length * OPTION_ROW_HEIGHT + 8, 288)
    const estimatedHeight = SEARCH_ROW_HEIGHT + listHeight
    const spaceBelow = window.innerHeight - r.bottom - 8
    const spaceAbove = r.top - 8
    const placement =
      spaceBelow < estimatedHeight && spaceAbove > spaceBelow ? "above" : "below"
    const top =
      placement === "below"
        ? Math.round(r.bottom + 4)
        : Math.round(r.top - estimatedHeight - 4)

    setPopPos({
      top,
      left: Math.round(r.left),
      minWidth,
      maxWidth,
      placement,
    })
  }, [filteredOptions.length, options])

  const closePopover = useCallback((): void => {
    setOpen(false)
    setQuery("")
    releasePopoverOpen(instanceId)
  }, [instanceId])

  const openPopover = useCallback((): void => {
    claimPopoverOpen(instanceId)
    setOpen(true)
  }, [instanceId])

  useEffect(() => registerPopoverInstance(instanceId, closePopover), [instanceId, closePopover])

  function togglePopover(): void {
    if (disabled) return
    if (open) closePopover()
    else openPopover()
  }

  function selectOption(option: ListboxOption<T>): void {
    if (option.disabled) return
    onChange(option.value)
    closePopover()
    btnRef.current?.focus()
  }

  // Close after outside click (click, not mousedown — avoids racing option selection in modals).
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent): void {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popRef.current?.contains(e.target as Node)) return
      closePopover()
    }
    document.addEventListener("click", handle)
    return () => document.removeEventListener("click", handle)
  }, [open, closePopover])

  // Position the popup beneath the trigger; keep aligned while scrolling inside modals.
  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null)
      return
    }
    updatePopPos()
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open, updatePopPos])

  useEffect(() => {
    if (!open) return
    updatePopPos()
    const idx = filteredOptions.findIndex((o) => o.value === value)
    setActiveIdx(idx >= 0 ? idx : filteredOptions.length > 0 ? 0 : -1)
  }, [open, query, value, filteredOptions, updatePopPos])

  useEffect(() => {
    if (!open) return
    const onReposition = () => updatePopPos()
    window.addEventListener("resize", onReposition)
    window.addEventListener("scroll", onReposition, true)
    return () => {
      window.removeEventListener("resize", onReposition)
      window.removeEventListener("scroll", onReposition, true)
    }
  }, [open, updatePopPos])

  function onPopoverKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault()
      closePopover()
      btnRef.current?.focus()
      return
    }
    if (filteredOptions.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(filteredOptions.length - 1, i < 0 ? 0 : i + 1))
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i <= 0 ? 0 : i - 1))
    }
    if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault()
      const option = filteredOptions[activeIdx]
      if (option) selectOption(option)
    }
  }

  const sizeCls =
    size === "sm" && variant === "segment" ? "px-3 py-2 text-sm"
    : size === "sm" ? "px-2.5 py-1.5 text-sm"
    : size === "lg" ? "px-4 py-3 text-base"
    : "px-3 py-2 text-sm"

  const variantCls =
    variant === "ghost" ? "bg-transparent hover:bg-elevated/60 border border-transparent hover:border-border"
    : variant === "segment" ? "bg-transparent hover:bg-elevated/60 border-0 rounded-md"
    : variant === "card" ? "bg-base/60 hover:bg-base border border-border hover:border-border-focus"
    : "bg-base hover:bg-elevated border border-border hover:border-border-focus"

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? caption}
        onClick={togglePopover}
        className={[
          "group flex w-full min-w-0 items-center gap-2 rounded-md transition-colors text-left text-text overflow-hidden",
          "focus:outline-none focus:ring-2 focus:ring-accent/40",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          sizeCls, variantCls, className,
        ].join(" ")}
      >
        {selected?.dot && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: selected.dot }}
          />
        )}
        <span className="flex-1 min-w-0 flex flex-col items-start">
          {caption && (
            <span className="text-xs uppercase tracking-wider text-text-muted leading-none mb-1">{caption}</span>
          )}
          <span className="truncate leading-snug text-sm">
            {selected?.label ?? <span className="text-text-muted font-normal">{placeholder}</span>}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && popPos && createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: popoverZIndex() - 1, pointerEvents: "none" }}
            aria-hidden
          />
          <div
            ref={popRef}
            role="listbox"
            onKeyDown={onPopoverKeyDown}
            className="listbox-popover fixed flex max-h-72 flex-col overflow-hidden rounded-md"
            style={{
              top: popPos.top,
              left: popPos.left,
              minWidth: popPos.minWidth,
              maxWidth: popPos.maxWidth,
              width: "max-content",
              zIndex: popoverZIndex(),
            }}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden />
              <input
                ref={searchRef}
                type="text"
                role="searchbox"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && filteredOptions.length > 0) {
                    e.preventDefault()
                    setActiveIdx(0)
                  }
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-text-muted">
                  No matches{query.trim() ? ` for “${query.trim()}”` : ""}.
                </p>
              ) : (
                filteredOptions.map((o, i) => {
                  const isSel = o.value === value
                  const isActive = i === activeIdx
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      disabled={o.disabled}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        selectOption(o)
                      }}
                      className={[
                        "listbox-popover__option w-full flex items-start gap-2 px-3 py-2 text-left transition-colors",
                        o.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                        isActive && !o.disabled ? "bg-accent/15 text-text" : "text-text",
                        isSel && !isActive ? "bg-overlay-1" : "",
                      ].join(" ")}
                    >
                      {showDots
                        ? o.dot
                          ? <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: o.dot }} />
                          : <span className="mt-1.5 w-2 h-2 shrink-0" />
                        : null}
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm leading-snug">{o.label}</span>
                        {o.hint && (
                          <span className="mt-0.5 block text-xs leading-snug text-text-muted">
                            {o.hint}
                          </span>
                        )}
                      </span>
                      {isSel && <Check size={13} className="mt-0.5 text-accent shrink-0" />}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
