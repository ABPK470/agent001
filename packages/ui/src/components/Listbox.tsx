/**
 * Listbox — minimal, accessible, theme-aware dropdown.
 * Replaces native <select> for a consistent platform feel.
 */

import { Check, ChevronDown } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

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
  variant?: "default" | "ghost" | "card"
  className?: string
  ariaLabel?: string
  disabled?: boolean
}

export function Listbox<T extends string>({
  value, options, onChange, placeholder = "Select…",
  caption, size = "md", variant = "default", className = "", ariaLabel, disabled,
}: ListboxProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [popPos, setPopPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const selected = options.find((o) => o.value === value) ?? null

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus() }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(options.length - 1, i + 1)) }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)) }
      if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault()
        const o = options[activeIdx]
        if (o && !o.disabled) { onChange(o.value); setOpen(false); btnRef.current?.focus() }
      }
    }
    document.addEventListener("mousedown", handle)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", onKey) }
  }, [open, options, activeIdx, onChange])

  // Position the popup beneath the trigger
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPopPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 180) })
    setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open, options, value])

  const sizeCls =
    size === "sm" ? "px-2.5 py-1.5 text-xs"
    : size === "lg" ? "px-4 py-3 text-sm"
    : "px-3 py-2 text-sm"

  const variantCls =
    variant === "ghost" ? "bg-transparent hover:bg-elevated/60 border border-transparent hover:border-border"
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
        onClick={() => !disabled && setOpen((o) => !o)}
        className={[
          "group inline-flex items-center gap-2 rounded-md transition-colors text-left text-text",
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
            <span className="text-[10px] uppercase tracking-wider text-text-muted leading-none mb-1">{caption}</span>
          )}
          <span className="truncate font-medium leading-none">
            {selected?.label ?? <span className="text-text-muted">{placeholder}</span>}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && popPos && createPortal(
        <div
          ref={popRef}
          role="listbox"
          style={{
            position: "fixed",
            top: popPos.top, left: popPos.left, minWidth: popPos.width,
            zIndex: 9999,
          }}
          className="bg-elevated border border-border rounded-md shadow-2xl py-1 max-h-72 overflow-y-auto"
        >
          {options.map((o, i) => {
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
                onClick={() => {
                  if (o.disabled) return
                  onChange(o.value); setOpen(false); btnRef.current?.focus()
                }}
                className={[
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors",
                  o.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                  isActive && !o.disabled ? "bg-accent/15 text-text" : "text-text-secondary",
                ].join(" ")}
              >
                {o.dot
                  ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: o.dot }} />
                  : <span className="w-2 h-2 shrink-0" />}
                <span className="flex-1 truncate">{o.label}</span>
                {o.hint && <span className="text-[11px] text-text-muted shrink-0 truncate">{o.hint}</span>}
                {isSel && <Check size={13} className="text-accent shrink-0" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
