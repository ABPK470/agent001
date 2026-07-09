/**
 * Entity-registry rail primitives for Sync Operations list columns + section nav.
 */

import type { JSX, ReactNode } from "react"

import { IconButton, TOOLBAR_ICON } from "../entity-registry/IconButton"

export { TOOLBAR_ICON }

/** @deprecated use TOOLBAR_ICON */
export const RAIL_ICON = TOOLBAR_ICON

export function RailListGroup({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}): JSX.Element {
  return (
    <li className="entity-rail-group">
      <div className="entity-rail-group__header">
        <span className="entity-rail-group__label">{label}</span>
        {count != null ? <span className="entity-rail-group__count">{count}</span> : null}
      </div>
      <ul className="entity-rail-group__list">{children}</ul>
    </li>
  )
}

export function RailListItem({
  active,
  onClick,
  title,
  meta,
  meta2,
}: {
  active: boolean
  onClick: () => void
  title: ReactNode
  meta?: ReactNode
  meta2?: ReactNode
}): JSX.Element {
  return (
    <li className={`entity-rail-item-wrap ${active ? "entity-rail-item-wrap--active" : ""}`}>
      <div className="entity-rail-item-row">
        <button
          type="button"
          onClick={onClick}
          className="entity-rail-item min-w-0 flex-1 text-left"
        >
          <span className="entity-rail-item-title block min-w-0 truncate">{title}</span>
          {meta != null && meta !== "" && (
            <span className="entity-rail-item-meta block min-w-0 truncate">{meta}</span>
          )}
          {meta2 != null && meta2 !== "" && (
            <span className="entity-rail-item-meta block min-w-0 truncate">{meta2}</span>
          )}
        </button>
      </div>
    </li>
  )
}

export function RailList({ children, label }: { children: ReactNode; label?: string }): JSX.Element {
  return (
    <ul className="entity-rail-list" aria-label={label}>
      {children}
    </ul>
  )
}

export function RailEmpty({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="px-3 py-10 text-center text-sm text-text-muted">
      <p className="font-medium text-text">{title}</p>
      {children ? <p className="mt-1">{children}</p> : null}
    </div>
  )
}

export function ToolbarIconBtn({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <IconButton label={label} onClick={onClick} disabled={disabled} active={active}>
      {children}
    </IconButton>
  )
}

/** @deprecated use ToolbarIconBtn / IconButton */
export function RailHeaderBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <ToolbarIconBtn label={label} onClick={onClick} disabled={disabled}>
      {children}
    </ToolbarIconBtn>
  )
}
