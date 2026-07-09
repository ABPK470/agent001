/**
 * Widget toolbar — shared banner for Event Stream, Pipelines, Manual Sync.
 *
 * Layout (wide):  [ leading filters ] [ search ············ ] [ trailing ]
 * Layout (compact): row1 = leading full width
 *                   row2 = search flex + trailing
 */

import { Loader2, Search, X } from "lucide-react"
import type { JSX, ReactNode } from "react"

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

/** Aliases — Event Stream / Pipelines imports */
export const LogWidgetToolbar = WidgetToolbar
export const LogWidgetToolbarFilters = WidgetToolbarLeading
export const LogWidgetToolbarTail = WidgetToolbarTrailing
export const LogWidgetToolbarSearch = WidgetToolbarSearch
export const LogWidgetToolbarCount = WidgetToolbarCount
