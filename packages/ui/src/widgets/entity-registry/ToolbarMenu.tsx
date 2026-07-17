/**
 * Anchored icon trigger + dropdown — portaled so parent overflow cannot clip.
 */

import type { JSX, ReactNode } from "react"
import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconButton } from "./IconButton"

export const TOOLBAR_MENU_ITEM =
  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text-muted transition-colors hover:bg-overlay-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"

export const TOOLBAR_MENU_ITEM_DANGER =
  `${TOOLBAR_MENU_ITEM} text-rose-400 hover:text-rose-300`

export interface ToolbarMenuProps {
  title: string
  ariaLabel: string
  trigger: ReactNode
  children: ReactNode
  minWidthClass?: string
  /** Smaller trigger for dense lists */
  compact?: boolean
}

export function ToolbarMenu({
  title,
  trigger,
  children,
  minWidthClass = "min-w-[11rem]",
  compact = false,
}: ToolbarMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  function close(): void {
    setOpen(false)
  }

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setMenuPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      minWidth: Math.max(rect.width, 180),
    })
  }, [open])

  return (
    <div className="relative shrink-0">
      <IconButton
        ref={btnRef}
        label={title}
        onClick={() => setOpen((value) => !value)}
        active={open}
        className={compact ? "!w-7 !h-7 !rounded-md" : undefined}
        aria-expanded={open}
      >
        {trigger}
      </IconButton>
      {open && menuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[250]" onClick={close} aria-hidden />
          <div
            className={`fixed z-[260] ${minWidthClass} rounded-md border border-border-subtle bg-elevated py-1 shadow-2xl`}
            style={{ top: menuPos.top, right: menuPos.right, minWidth: menuPos.minWidth }}
            role="menu"
            onClick={close}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

export function ToolbarMenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={danger ? TOOLBAR_MENU_ITEM_DANGER : TOOLBAR_MENU_ITEM}
    >
      {icon}
      {label}
    </button>
  )
}
