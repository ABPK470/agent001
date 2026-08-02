/**
 * Widget toolbar — review-family banner (Event Stream, Pipelines, Trace).
 * Sync may share the shell/inset; its leading controls stay act-widget special.
 *
 * Layout (wide):  [ leading filters ] [ search ············ ] [ trailing ]
 * Layout (compact): row1 = leading full width
 *                   row2 = search flex + trailing
 *
 * Chrome:
 *   Panel widgets: widget-panel = outer inset; stack = inner inset (controls + list).
 *   Chat (canvas): widget-content-gutter on the transcript column.
 *   widget-review-controls groups toolbar + band 2 inside the panel.
 */

import { Loader2, Search, X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanelForElements } from "../lib/anchored-panel"
import { BrowseCount } from "../components/BrowseStrip"

/** @deprecated Shell owns gutter — kept for modal/tooling references. */
export const WIDGET_LOG_INSET_CLASS = ""

/** Full-height body inside `widget-panel` — no extra tile inset. */
export const WIDGET_LOG_SHELL_CLASS =
  "flex h-full min-h-0 flex-1 flex-col overflow-hidden text-text"

/** Outer content gutter — toolbar + stack align with Chat / Threads. */
export const WIDGET_CONTENT_GUTTER_CLASS = "widget-content-gutter"

/** Inner scroll/list gutter — second layer inside outer. */
export const WIDGET_CONTENT_GUTTER_INNER_CLASS = "widget-content-gutter-inner"

/** Column under widget-panel — inner gutter insets controls + scroll together. */
export const WIDGET_LOG_STACK_CLASS =
  `widget-panel-stack ${WIDGET_CONTENT_GUTTER_INNER_CLASS}`

/** Flex body slot — inner panes own scroll (Trace split). */
export const WIDGET_LOG_BODY_CLASS = "widget-panel-body"

/** Scroll host under review controls — list virtualizes inside this element. */
export const WIDGET_LOG_SCROLL_CLASS = "widget-panel-body widget-panel-body--scroll"

/** Toolbar + optional filter/meta band — one panel-2 control surface. */
export const WIDGET_REVIEW_CONTROLS_CLASS = "widget-review-controls"

/** Shared horizontal inset for each band row inside review-controls. */
export const WIDGET_REVIEW_CONTROLS_INSET_CLASS = "widget-review-controls__inset"

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
        <Search size={14} strokeWidth={1.75} className="widget-toolbar__search-icon" aria-hidden />
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
          <Loader2 size={14} strokeWidth={1.75} className="widget-toolbar__search-spinner" aria-hidden />
        )}
        {value && !loading && (
          <button
            type="button"
            className="widget-toolbar__search-clear"
            onClick={() => (onClear ? onClear() : onChange(""))}
            aria-label="Clear search"
          >
            <X size={14} strokeWidth={1.75} />
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
  /** Drop digit reserves — sit flush next to an icon. */
  compact,
}: {
  filtered: number
  total: number
  hidden?: boolean
  compact?: boolean
}): JSX.Element | null {
  return (
    <BrowseCount
      filtered={filtered}
      total={total}
      hidden={hidden}
      compact={compact}
    />
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
        active
          ? "text-text font-medium bg-[var(--select-fill)]"
          : "text-text-muted hover:text-text hover:bg-[var(--hover-fill)]"
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
