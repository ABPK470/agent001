import { Loader2 } from "lucide-react"
import type { ButtonHTMLAttributes, JSX, ReactNode } from "react"

import { ModalShell } from "../ModalShell"

export function ModalBtnSecondary({
  children,
  className = "",
  danger = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={[
        "inline-flex h-9 items-center justify-center gap-1.5 px-4 text-sm border rounded-lg disabled:opacity-40",
        danger
          ? "border-error/30 text-error hover:bg-error/10"
          : "border-border-subtle text-text-muted hover:bg-overlay-2 hover:text-text",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  )
}

export function ModalBtnPrimary({
  children,
  className = "",
  danger = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={[
        "inline-flex h-9 items-center justify-center gap-1.5 px-4 text-sm rounded-lg disabled:opacity-40",
        danger
          ? "bg-error text-text hover:bg-error/90"
          : "bg-accent hover:bg-accent-hover text-text",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  )
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  error = null,
  stackLevel = 0,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  error?: string | null
  stackLevel?: number
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <ModalShell
      title={title}
      size="detail"
      stackLevel={stackLevel}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <ModalBtnSecondary onClick={onCancel} disabled={busy}>Cancel</ModalBtnSecondary>
          <div className="ml-auto">
            <ModalBtnPrimary danger={danger} disabled={busy} onClick={onConfirm}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {confirmLabel}
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <div className="px-6 py-5">
        <p className="text-sm leading-relaxed text-text-muted">{message}</p>
        {error && (
          <p className="mt-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </ModalShell>
  )
}

export function GovernanceIconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-muted transition-colors hover:bg-elevated hover:text-text"
    >
      {children}
    </button>
  )
}
