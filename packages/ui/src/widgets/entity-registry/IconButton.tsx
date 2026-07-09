/**
 * Unified toolbar icon button — shared by Entity Registry, Sync Admin, Env Sync.
 */

import { forwardRef } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"

import { ICON_BTN, ICON_BTN_PRIMARY } from "./chrome"

/** Lucide props for w-9 toolbar buttons. */
export const TOOLBAR_ICON = { size: 16, strokeWidth: 1.75 } as const

const ICON_BTN_ACTIVE =
  `${ICON_BTN} bg-elevated text-text`

const ICON_BTN_TRACK_BASE =
  "flex items-center justify-center w-9 h-9 shrink-0 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"

const ICON_BTN_TRACK =
  `${ICON_BTN_TRACK_BASE} text-text-muted hover:bg-elevated/60 hover:text-text`

const ICON_BTN_TRACK_ACTIVE =
  `${ICON_BTN_TRACK_BASE} bg-elevated text-text shadow-sm`

const ICON_BTN_GROUP_BASE =
  "flex items-center justify-center shrink-0 w-9 h-full min-h-0 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"

const ICON_BTN_GROUP =
  `${ICON_BTN_GROUP_BASE} text-text-muted hover:bg-elevated/60 hover:text-text`

const ICON_BTN_GROUP_ACTIVE =
  `${ICON_BTN_GROUP_BASE} bg-elevated text-text`

export type IconButtonVariant = "default" | "primary" | "track" | "group"

export function iconButtonClass({
  variant = "default",
  active = false,
}: {
  variant?: IconButtonVariant
  active?: boolean
} = {}): string {
  if (variant === "primary") return ICON_BTN_PRIMARY
  if (variant === "track") return active ? ICON_BTN_TRACK_ACTIVE : ICON_BTN_TRACK
  if (variant === "group") return active ? ICON_BTN_GROUP_ACTIVE : ICON_BTN_GROUP
  if (active) return ICON_BTN_ACTIVE
  return ICON_BTN
}

export const IconButton = forwardRef(function IconButton({
  label,
  variant = "default",
  active = false,
  className = "",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string
  variant?: IconButtonVariant
  active?: boolean
  children: ReactNode
}, ref: React.ForwardedRef<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`${iconButtonClass({ variant, active })} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  )
})
