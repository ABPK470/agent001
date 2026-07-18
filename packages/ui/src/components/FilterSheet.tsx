/**
 * Filter sheet — labeled form in a popover (not a grid of mystery dropdowns).
 * Pair with ActiveFilterChips for what’s currently applied.
 */

import { X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanel } from "../lib/anchored-panel"
import { popoverZIndex } from "../lib/modal-stack"
import { dismissOpenPopovers } from "../lib/popover-dismiss"

/**
 * Clicks inside nested portaled pickers (DateField / Listbox use `.listbox-popover`)
 * must not dismiss the sheet — those portals render outside the sheet DOM.
 */
function isNestedPickerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".listbox-popover") != null
}

export function FilterSheet({
  open,
  onClose,
  anchorRef,
  title = "Filters",
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement | null>
  title?: string
  children: ReactNode
  footer?: ReactNode
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  // Do not register with claimPopoverOpen — DateField/Listbox inside the sheet
  // claim that slot; treating the sheet as a peer would close it when they open.

  const close = useCallback((): void => {
    dismissOpenPopovers()
    onClose()
  }, [onClose])

  const updatePos = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const width = Math.min(360, Math.max(280, window.innerWidth - 32))
    const placed = placeAnchoredPanel({
      trigger: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      panel: { width, height: panelRef.current?.offsetHeight ?? 420 },
      align: "end",
      viewport: { width: window.innerWidth, height: window.innerHeight },
    })
    setPos({ top: placed.top, left: placed.left, width })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    updatePos()
  }, [open, updatePos, children])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      if (isNestedPickerTarget(e.target)) return
      close()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", updatePos)
    window.addEventListener("scroll", updatePos, true)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", updatePos)
      window.removeEventListener("scroll", updatePos, true)
    }
  }, [open, close, updatePos, anchorRef])

  if (!open || !pos) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      className="listbox-popover fixed flex max-h-[min(70vh,32rem)] flex-col overflow-hidden rounded-lg border border-border-subtle shadow-lg"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: popoverZIndex(),
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <span className="text-sm font-medium text-text">{title}</span>
        <button
          type="button"
          onClick={close}
          className="rounded-md p-1 text-text-muted hover:bg-elevated hover:text-text"
          aria-label="Close filters"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">{children}</div>
      {footer && (
        <div className="shrink-0 border-t border-border-subtle px-3 py-2">{footer}</div>
      )}
    </div>,
    document.body,
  )
}

/** Labeled block inside a filter sheet. */
export function FilterField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
      {children}
    </div>
  )
}

/** Multi-select toggles for a small fixed option set (status, kind). */
export function FilterToggles<T extends string>({
  options,
  values,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  values: readonly T[]
  onChange: (values: T[]) => void
}): JSX.Element {
  const selected = new Set(values)

  function toggle(value: T): void {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange([...next])
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const on = selected.has(option.value)
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(option.value)}
            className={[
              "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
              on
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border-subtle bg-base text-text-muted hover:border-border hover:text-text",
            ].join(" ")}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export type ActiveFilterChipModel = {
  id: string
  label: string
  value: string
  onRemove: () => void
}

/** Removable chips for filters that are currently on. */
export function ActiveFilterChips({
  chips,
  onClear,
}: {
  chips: ActiveFilterChipModel[]
  onClear?: () => void
}): JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={chip.onRemove}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border-subtle bg-elevated/50 px-2 py-1 text-xs text-text hover:border-border hover:bg-elevated"
          title={`Remove ${chip.label}`}
        >
          <span className="text-text-muted">{chip.label}</span>
          <span className="min-w-0 truncate font-medium">{chip.value}</span>
          <X size={11} className="shrink-0 text-text-faint" />
        </button>
      ))}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="ml-0.5 text-xs text-text-muted hover:text-text"
        >
          Clear
        </button>
      )}
    </div>
  )
}
