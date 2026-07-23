import { useCallback } from "react"

import { formatApiError } from "../lib/api-error"
import { ToastStack, useToasts } from "./ToastStack"

export function useWidgetToasts() {
  const { toasts, pushToast, dismissToast } = useToasts({ ok: 6_000, err: 12_000, info: 6_000 })

  const notify = useCallback((message: string) => pushToast(message, "ok"), [pushToast])
  const notifyError = useCallback((message: string) => pushToast(message, "err"), [pushToast])
  const notifyInfo = useCallback((message: string) => pushToast(message, "info"), [pushToast])
  /** Format any thrown/API failure through the shared copy path, then toast as err. */
  const notifyApiError = useCallback(
    (error: unknown) => pushToast(formatApiError(error), "err"),
    [pushToast],
  )

  return { toasts, dismissToast, pushToast, notify, notifyError, notifyApiError, notifyInfo }
}

export { ToastStack }
