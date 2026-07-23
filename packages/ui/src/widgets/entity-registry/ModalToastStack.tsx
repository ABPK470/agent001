import { useCallback, type JSX } from "react"
import {
  ToastStack,
  useToasts,
  type Toast,
  type ToastKind,
} from "../../components/ToastStack"
import { formatApiError } from "../../lib/api-error"

const AUTO_DISMISS_MS = 15_000

export type ModalToast = Pick<Toast, "id" | "message" | "kind">

export function useModalToasts(autoDismissMs = AUTO_DISMISS_MS): {
  toasts: ModalToast[]
  /** Default kind is `err` — pass `ok` / `info` for non-error feedback. */
  pushToast: (message: string, kind?: ToastKind) => void
  /** Format any thrown/API failure through the shared copy path, then toast as err. */
  notifyApiError: (error: unknown) => void
  dismissToast: (id: string) => void
  clearToasts: () => void
} {
  const { toasts, pushToast: push, dismissToast, clearToasts } = useToasts({
    ok: autoDismissMs,
    err: autoDismissMs,
    info: autoDismissMs,
  })

  const pushToast = useCallback(
    (message: string, kind: ToastKind = "err") => push(message, kind),
    [push],
  )

  const notifyApiError = useCallback(
    (error: unknown) => push(formatApiError(error), "err"),
    [push],
  )

  return {
    toasts,
    pushToast,
    notifyApiError,
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
      toasts={toasts}
      onDismiss={onDismiss}
      className="pointer-events-none absolute inset-y-3 right-3 z-30 flex w-[min(100%,20rem)] flex-col justify-end gap-2"
    />
  )
}
