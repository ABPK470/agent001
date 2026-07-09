import type { JSX } from "react"
import { ToastStack, useToasts, type Toast } from "../../components/ToastStack"

const AUTO_DISMISS_MS = 15_000

export type ModalToast = Pick<Toast, "id" | "message">

export function useModalToasts(autoDismissMs = AUTO_DISMISS_MS): {
  toasts: ModalToast[]
  pushToast: (message: string) => void
  dismissToast: (id: string) => void
  clearToasts: () => void
} {
  const { toasts, pushToast, dismissToast, clearToasts } = useToasts({ err: autoDismissMs })

  return {
    toasts: toasts.map(({ id, message }) => ({ id, message })),
    pushToast: (message) => pushToast(message, "err"),
    dismissToast,
    clearToasts,
  }
}

export function ModalToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ModalToast[]
  onDismiss: (id: string) => void
}): JSX.Element | null {
  if (toasts.length === 0) return null

  return (
    <ToastStack
      toasts={toasts.map((toast) => ({ ...toast, kind: "err" as const }))}
      onDismiss={onDismiss}
      className="pointer-events-none absolute inset-y-3 right-3 z-30 flex w-[min(100%,20rem)] flex-col justify-end gap-2"
    />
  )
}
