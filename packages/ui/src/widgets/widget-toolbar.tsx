/**
 * Widget toolbar — shared banner for Event Stream, Pipelines, Manual Sync.
 *
 * Layout (wide):  [ leading filters ] [ search ············ ] [ trailing ]
 * Layout (compact): row1 = leading full width
 *                   row2 = search flex + trailing
 *
 * Chrome (all three flush widgets):
 *   shell = top + left/right inset; stack = toolbar→body gap.
 *   Do not put margin on the toolbar itself — the shell owns the inset.
 */

import { Loader2, Search, X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanelForElements } from "../lib/anchored-panel"

/** Shared top/side/bottom inset (12px) — Event Stream, Pipelines, Sync. */
export const WIDGET_LOG_INSET_CLASS = "pt-3 px-3 pb-1"

/** Full-height shell for flush log widgets. */
export const WIDGET_LOG_SHELL_CLASS =
  `flex h-full min-h-0 flex-col overflow-hidden ${WIDGET_LOG_INSET_CLASS} text-text`

/** Column under the shell: toolbar then body with a shared gap. */
export const WIDGET_LOG_STACK_CLASS =
  "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"

/** @deprecated use WidgetToolbarChip classes via widget-toolbar__chip */
export const LOG_TOOLBAR_CHIP = "widget-toolbar__chip"
export const LOG_TOOLBAR_CHIP_ACTIVE = "widget-toolbar__chip--active"
export const LOG_TOOLBAR_CHIP_IDLE = "widget-toolbar__chip--idle"
export const LOG_TOOLBAR_ICON_BTN = "widget-toolbar__icon-btn"
export const LOG_TOOLBAR_DIVIDER = "widget-toolbar__divider"

export function WidgetToolbar({
  compact,
  className,
  children,
}: {
  compact?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={[
        "widget-toolbar shrink-0",
        compact ? "widget-toolbar--compact" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      <div className="widget-toolbar__grid">{children}</div>
    </div>
  )
}

export function WidgetToolbarLeading({ children }: { children: ReactNode }): JSX.Element {
  return <div className="widget-toolbar__leading">{children}</div>
}

export function WidgetToolbarSearch({
  value,
  onChange,
  placeholder,
  loading,
  onClear,
  autoFocus,
  mono,
  committed,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  loading?: boolean
  autoFocus?: boolean
  onClear?: () => void
  mono?: boolean
  committed?: boolean
}): JSX.Element {
  return (
    <div className="widget-toolbar__search">
      <div className="widget-toolbar__search-wrap">
        <Search size={13} className="widget-toolbar__search-icon" aria-hidden />
        <input
          type="text"
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-busy={loading || undefined}
          className={[
            "widget-toolbar__search-input",
            mono ? "font-mono" : "",
            committed ? "widget-toolbar__search-input--committed" : "",
          ].filter(Boolean).join(" ")}
        />
        {loading && (
          <Loader2 size={12} className="widget-toolbar__search-spinner" aria-hidden />
        )}
        {value && !loading && (
          <button
            type="button"
            className="widget-toolbar__search-clear"
            onClick={() => (onClear ? onClear() : onChange(""))}
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Search column with custom inner content (e.g. Manual Sync mode toggle + input). */
export function WidgetToolbarSearchSlot({ children }: { children: ReactNode }): JSX.Element {
  return <div className="widget-toolbar__search">{children}</div>
}

export function WidgetToolbarTrailing({ children }: { children: ReactNode }): JSX.Element {
  return <div className="widget-toolbar__trailing">{children}</div>
}

export function WidgetToolbarCount({
  filtered,
  total,
  hidden,
}: {
  filtered: number
  total: number
  hidden?: boolean
}): JSX.Element | null {
  if (hidden) return null
  return (
    <span className="widget-toolbar__count" aria-label={`${filtered} of ${total} shown`}>
      {filtered !== total ? (
        <>
          <span className="widget-toolbar__count-filtered">{filtered}</span>
          <span className="widget-toolbar__count-sep">/</span>
          <span className="widget-toolbar__count-total">{total}</span>
        </>
      ) : (
        <span className="widget-toolbar__count-total">{total}</span>
      )}
    </span>
  )
}

const FILTER_MENU_Z_BACKDROP = 250
const FILTER_MENU_Z_PANEL = 260

export interface WidgetToolbarFilterMenuProps {
  label: ReactNode
  active?: boolean
  ariaLabel?: string
  children: ReactNode
}

/** Chip trigger + portaled dropdown — escapes widget overflow clipping. */
export function WidgetToolbarFilterMenu({
  label,
  active,
  ariaLabel = "Filter",
  children,
}: WidgetToolbarFilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  function close(): void {
    setOpen(false)
  }

  function placeMenu(): void {
    const trigger = triggerRef.current
    if (!trigger) return
    const next = placeAnchoredPanelForElements(trigger, panelRef.current, {
      align: "start",
      estimate: { width: Math.max(trigger.getBoundingClientRect().width, 168), height: 240 },
    })
    setPos({
      top: next.top,
      left: next.left,
      minWidth: Math.max(trigger.getBoundingClientRect().width, 168),
    })
  }

  function openMenu(): void {
    placeMenu()
    setOpen(true)
  }

  function toggleMenu(): void {
    if (open) close()
    else openMenu()
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return

    placeMenu()
    const raf = requestAnimationFrame(placeMenu)
    const ro = panelRef.current ? new ResizeObserver(placeMenu) : null
    if (panelRef.current) ro?.observe(panelRef.current)
    window.addEventListener("resize", placeMenu)
    window.addEventListener("scroll", placeMenu, true)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener("resize", placeMenu)
      window.removeEventListener("scroll", placeMenu, true)
    }
  }, [open, children])

  useEffect(() => {
    if (!open) setPos(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={toggleMenu}
        className={`${LOG_TOOLBAR_CHIP} ${active ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE}`}
      >
        {label}
      </button>
      {open && createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: FILTER_MENU_Z_BACKDROP }}
            onClick={close}
            aria-hidden
          />
          <div
            ref={panelRef}
            role="menu"
            className="fixed max-h-[min(20rem,calc(100dvh-2rem))] overflow-y-auto rounded-md border border-border-subtle bg-elevated py-1 shadow-2xl"
            style={{
              zIndex: FILTER_MENU_Z_PANEL,
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              minWidth: pos?.minWidth ?? 168,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

export function WidgetToolbarFilterMenuItem({
  label,
  active,
  count,
  onClick,
}: {
  label: ReactNode
  active?: boolean
  count?: number
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] transition-colors ${
        active ? "bg-accent/10 text-accent font-medium" : "text-text-muted hover:bg-overlay-2 hover:text-text"
      }`}
    >
      <span>{label}</span>
      {count != null && count > 0 && (
        <span className="text-xs tabular-nums text-text-muted/60">{count}</span>
      )}
    </button>
  )
}

/** Aliases — Event Stream / Pipelines imports */
export const LogWidgetToolbar = WidgetToolbar
export const LogWidgetToolbarFilters = WidgetToolbarLeading
export const LogWidgetToolbarTail = WidgetToolbarTrailing
export const LogWidgetToolbarSearch = WidgetToolbarSearch
export const LogWidgetToolbarCount = WidgetToolbarCount
