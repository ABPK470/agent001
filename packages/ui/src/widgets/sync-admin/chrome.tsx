/**
 * Sync Operations modals — same shell and dimensions as entity-registry.
 */

import { Loader2 } from "lucide-react"
import type { ButtonHTMLAttributes, JSX, ReactNode } from "react"
import { useState } from "react"

import {
  ModalShell as RegistryModalShell,
  type ModalShellScrim,
  type ModalShellSize,
} from "../entity-registry/ModalShell"

export { Err, Loading } from "../env-sync/chrome"
export type { ModalShellSize }

export function ModalShell({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  size = "focus",
  stackLevel = 0,
  scrim,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: ModalShellSize
  stackLevel?: number
  scrim?: ModalShellScrim
}): JSX.Element {
  return (
    <RegistryModalShell
      title={title}
      subtitle={subtitle}
      icon={icon}
      onClose={onClose}
      size={size}
      scrim={scrim}
      stackLevel={stackLevel}
      footer={footer}
    >
      {children}
    </RegistryModalShell>
  )
}

/** @deprecated use size="focus" on ModalShell */
export const MODAL_PANEL_ENTITY = "focus"
/** @deprecated use size="focus" on ModalShell */
export const MODAL_PANEL_FORM = "focus"
/** @deprecated use size="detail" on ModalShell */
export const MODAL_PANEL_COMPACT = "detail"
/** @deprecated use size="focus" on ModalShell */
export const MODAL_PANEL_WIDE = "focus"

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

/** Detail-pane action — matches Approvals / Strategies button row. */
export function DetailActionBtn({
  children,
  className = "",
  variant = "default",
  danger = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  danger?: boolean
  variant?: "default" | "accent" | "info"
}): JSX.Element {
  const tone =
    variant === "accent" ? "border-accent/30 text-accent"
      : variant === "info" ? "border-info/30 text-info"
        : ""
  return (
    <ModalBtnSecondary
      danger={danger}
      className={["inline-flex items-center gap-1.5", tone, className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </ModalBtnSecondary>
  )
}

export function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-text-muted">{hint}</span>}
    </label>
  )
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  error = null,
  stackLevel = 1,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  error?: string | null
  /** Stack above parent modals — default 1 for nested confirms. */
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

export function PromptModal({
  title,
  label,
  placeholder,
  submitLabel = "Submit",
  busy = false,
  stackLevel = 1,
  onSubmit,
  onCancel,
}: {
  title: string
  label: string
  placeholder?: string
  submitLabel?: string
  busy?: boolean
  stackLevel?: number
  onSubmit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState("")

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
            <ModalBtnPrimary disabled={busy || !value.trim()} onClick={() => onSubmit(value.trim())}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {submitLabel}
            </ModalBtnPrimary>
          </div>
        </>
      }
    >
      <div className="px-6 py-5">
        <FormField label={label}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="input w-full py-2 text-sm"
            autoFocus
          />
        </FormField>
      </div>
    </ModalShell>
  )
}
