/**
 * Unified toolbar icon button — shared by Entity Registry, Sync Admin, Env Sync.
 */

import { forwardRef } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"

import { SELECT_ACTIVE, SELECT_FOCUS, SELECT_IDLE } from "../../lib/selection"
import { ICON_BTN } from "./chrome"

/** Lucide props for w-9 toolbar buttons. */
export const TOOLBAR_ICON = { size: 16, strokeWidth: 1.75 } as const

const ICON_BTN_ACTIVE =
  `${ICON_BTN} ${SELECT_ACTIVE}`

const ICON_BTN_TRACK_BASE =
  `flex items-center justify-center w-9 h-9 shrink-0 rounded-md ${SELECT_FOCUS} disabled:opacity-40 disabled:cursor-not-allowed`

const ICON_BTN_TRACK =
  `${ICON_BTN_TRACK_BASE} ${SELECT_IDLE}`

const ICON_BTN_TRACK_ACTIVE =
  `${ICON_BTN_TRACK_BASE} ${SELECT_ACTIVE}`

const ICON_BTN_GROUP_BASE =
  `flex items-center justify-center shrink-0 w-9 h-full min-h-0 rounded-md ${SELECT_FOCUS} disabled:opacity-40 disabled:cursor-not-allowed`

const ICON_BTN_GROUP =
  `${ICON_BTN_GROUP_BASE} ${SELECT_IDLE}`

const ICON_BTN_GROUP_ACTIVE =
  `${ICON_BTN_GROUP_BASE} ${SELECT_ACTIVE}`

export type IconButtonVariant = "default" | "primary" | "track" | "group"

export function iconButtonClass({
  variant = "default",
  active = false,
}: {
  variant?: IconButtonVariant
  active?: boolean
} = {}): string {
  // primary = quiet bordered (same as default). Accent fill is for labeled CTAs only.
  if (variant === "primary" || variant === "default") {
    return active ? ICON_BTN_ACTIVE : ICON_BTN
  }
  if (variant === "track") return active ? ICON_BTN_TRACK_ACTIVE : ICON_BTN_TRACK
  if (variant === "group") return active ? ICON_BTN_GROUP_ACTIVE : ICON_BTN_GROUP
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
