/**
 * Unified toolbar icon button — shared by Entity Registry, Sync Admin, Env Sync.
 *
 * default/primary active = CONTROL pressed (border + ink), never SELECT fill.
 * track/group active = MODE fill — only when inside a real SELECT_TRACK.
 */

import { forwardRef } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"

import {
  CONTROL_PRESSED,
  CONTROL_READY,
  SELECT_ACTIVE,
  SELECT_FOCUS,
  SELECT_IDLE,
} from "../../lib/selection"
import { ICON_BTN } from "./chrome"

/** Lucide props for w-9 toolbar buttons. */
export const TOOLBAR_ICON = { size: 16, strokeWidth: 1.75 } as const

const ICON_BTN_ACTIVE =
  `${ICON_BTN} ${CONTROL_PRESSED}`

const ICON_BTN_READY =
  `${ICON_BTN} ${CONTROL_READY}`

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
  ready = false,
}: {
  variant?: IconButtonVariant
  active?: boolean
  /** Next-step go-to — ink fill. Wins over active on default/primary. */
  ready?: boolean
} = {}): string {
  // primary = quiet bordered (same as default). Labeled CTAs use ACTION_BTN.
  if (variant === "primary" || variant === "default") {
    if (ready) return ICON_BTN_READY
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
  ready = false,
  className = "",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string
  variant?: IconButtonVariant
  active?: boolean
  ready?: boolean
  children: ReactNode
}, ref: React.ForwardedRef<HTMLButtonElement>) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`${iconButtonClass({ variant, active, ready })} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  )
})
