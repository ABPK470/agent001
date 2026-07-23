/**
 * Anchored icon trigger + dropdown — portaled so parent overflow cannot clip.
 * Placement flips above the trigger when there is not enough room below.
 */

import type { JSX, ReactNode } from "react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanelForElements } from "../../lib/anchored-panel"
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
  /** Match IconButton chrome when nested in a segment track. */
  variant?: "default" | "group"
}

const MENU_ESTIMATE = { width: 180, height: 160 }

export function ToolbarMenu({
  title,
  trigger,
  children,
  minWidthClass = "min-w-[11rem]",
  compact = false,
  variant = "default",
}: ToolbarMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  function close(): void {
    setOpen(false)
    setMenuPos(null)
  }

  function placeMenu(): void {
    const btn = btnRef.current
    if (!btn) return
    const next = placeAnchoredPanelForElements(btn, panelRef.current, {
      align: "end",
      estimate: MENU_ESTIMATE,
    })
    const triggerW = btn.getBoundingClientRect().width
    setMenuPos({
      top: next.top,
      left: next.left,
      minWidth: Math.max(triggerW, 180),
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    placeMenu()
  }, [open])

  useEffect(() => {
    if (!open) return
    const reposition = () => placeMenu()
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    return () => {
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [open])

  return (
    <div className={`relative shrink-0${variant === "group" ? " self-stretch flex" : ""}`}>
      <IconButton
        ref={btnRef}
        label={title}
        variant={variant}
        onClick={() => {
          if (open) {
            close()
            return
          }
          const btn = btnRef.current
          if (!btn) return
          const next = placeAnchoredPanelForElements(btn, null, {
            align: "end",
            estimate: MENU_ESTIMATE,
          })
          setMenuPos({
            top: next.top,
            left: next.left,
            minWidth: Math.max(btn.getBoundingClientRect().width, 180),
          })
          setOpen(true)
        }}
        active={open}
        className={
          variant === "group"
            ? "!w-8 !min-w-8 !h-auto !self-stretch !rounded-md"
            : compact
              ? "!w-7 !h-7 !rounded-md"
              : undefined
        }
        aria-expanded={open}
      >
        {trigger}
      </IconButton>
      {open && menuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[250]" onClick={close} aria-hidden />
          <div
            ref={panelRef}
            className={`fixed z-[260] ${minWidthClass} rounded-md border border-border-subtle bg-elevated py-1 shadow-2xl`}
            style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.minWidth }}
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
