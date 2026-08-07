/**
 * Filter sheet — labeled form in a popover (not a grid of mystery dropdowns).
 * Pair with ActiveFilterChips for what’s currently applied.
 *
 * Placement measures the real panel after mount. A tall height guess wrongly
 * flips short sheets (Pipelines) to the viewport top when space below the
 * trigger is tight — Event Stream’s taller sheet masked the same bug.
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
import { toggleMultiFilterChoice } from "../lib/filter-multi-select"
import { popoverZIndex } from "../lib/modal-stack"
import { dismissOpenPopovers } from "../lib/popover-dismiss"
import { CONTROL_IDLE, CONTROL_PRESSED } from "../lib/selection"

/**
 * Clicks inside nested portaled pickers (DateField / Listbox use `.listbox-popover`)
 * must not dismiss the sheet — those portals render outside the sheet DOM.
 */
function isNestedPickerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".listbox-popover") != null
}

const SHEET_WIDTH_MIN = 280
const SHEET_WIDTH_MAX = 360
/** First-paint guess only — real height comes from the mounted panel. */
const SHEET_HEIGHT_ESTIMATE = 240

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

  const updatePos = useCallback((): void => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const width = Math.min(SHEET_WIDTH_MAX, Math.max(SHEET_WIDTH_MIN, window.innerWidth - 32))
    const measured = panelRef.current?.offsetHeight
    const height =
      measured != null && measured > 0 ? measured : SHEET_HEIGHT_ESTIMATE
    const placed = placeAnchoredPanel({
      trigger: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
      panel: { width, height },
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
    // Mount first (visibility:hidden), measure, then place — same dialect as
    // WidgetToolbarFilterMenu. Never place with a tall fixed guess alone.
    updatePos()
    const raf = requestAnimationFrame(updatePos)
    const panel = panelRef.current
    const ro = panel ? new ResizeObserver(updatePos) : null
    if (panel) ro?.observe(panel)
    window.addEventListener("resize", updatePos)
    window.addEventListener("scroll", updatePos, true)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener("resize", updatePos)
      window.removeEventListener("scroll", updatePos, true)
    }
  }, [open, updatePos, children, footer])

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
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      className="listbox-popover fixed flex max-h-[min(70vh,32rem)] flex-col overflow-hidden rounded-lg border border-border-subtle shadow-lg"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: pos?.width ?? SHEET_WIDTH_MIN,
        zIndex: popoverZIndex(),
        visibility: pos ? "visible" : "hidden",
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
      <div className="review-group-label">{label}</div>
      {children}
    </div>
  )
}

/**
 * Filter choice chip — CONTROL dialect (keep the frame).
 * Never SELECT_* alone: transparent borders read as plain text on paper.
 */
const FILTER_CHOICE_BTN = "filter-choice-btn rounded-md px-2 py-1.5 text-xs font-medium"
const FILTER_CHOICE_ON = CONTROL_PRESSED
const FILTER_CHOICE_OFF = CONTROL_IDLE

/**
 * Choice grid — Event Stream Quick range / Type / Severity, Sync History, Pipelines.
 * `multi` = checkbox chips; `single` = radio (one value, or none when cleared).
 * `emptyMeansAll` (multi only): empty set is implicit all — first click excludes
 * the target (all except X). Allow-list toggles leave this off.
 *
 * Optional `className` on an option is the *selected* tone only (e.g. Event Stream
 * lane badge). Idle stays muted CONTROL_IDLE so pressed state stays 2-way syncable
 * with ActiveFilterChips.
 */
export function FilterChoiceGrid<T extends string>({
  options,
  values,
  onChange,
  columns = 3,
  mode = "multi",
  emptyMeansAll = false,
}: {
  options: readonly { value: T; label: string; className?: string }[]
  values: readonly T[]
  onChange: (values: T[]) => void
  columns?: 2 | 3 | 4
  mode?: "multi" | "single"
  emptyMeansAll?: boolean
}): JSX.Element {
  const selected = new Set(values)

  function choose(value: T): void {
    if (mode === "single") {
      onChange([value])
      return
    }
    if (emptyMeansAll) {
      onChange(toggleMultiFilterChoice(options.map((o) => o.value), values, value))
      return
    }
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange([...next])
  }

  const colClass =
    columns === 2 ? "grid-cols-2" : columns === 4 ? "grid-cols-4" : "grid-cols-3"

  return (
    <div className={`grid ${colClass} gap-1.5`}>
      {options.map((option) => {
        const on = selected.has(option.value)
        const tone = on && option.className ? option.className : ""
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => choose(option.value)}
            className={[
              FILTER_CHOICE_BTN,
              // Lane badge replaces CONTROL_PRESSED fill when a tone is provided.
              on ? (tone ? "" : FILTER_CHOICE_ON) : FILTER_CHOICE_OFF,
              tone,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {option.label}
          </button>
        )
      })}
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
  return (
    <FilterChoiceGrid
      options={options}
      values={values}
      onChange={onChange}
      columns={3}
      mode="multi"
    />
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
    <div className="widget-filter-band">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={chip.onRemove}
          className="widget-filter-chip"
          title={`Remove ${chip.label}`}
        >
          <span className="widget-filter-chip__label">{chip.label}</span>
          <span className="widget-filter-chip__value">{chip.value}</span>
          <X size={11} className="widget-filter-chip__x" aria-hidden />
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
