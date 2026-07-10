import { useCallback } from "react"

import { ToastStack, useToasts } from "../components/ToastStack"

export function useWidgetToasts() {
  const { toasts, pushToast, dismissToast } = useToasts({ ok: 6_000, err: 12_000, info: 6_000 })

  const notify = useCallback((message: string) => pushToast(message, "ok"), [pushToast])
  const notifyError = useCallback((message: string) => pushToast(message, "err"), [pushToast])
  const notifyInfo = useCallback((message: string) => pushToast(message, "info"), [pushToast])

  return { toasts, dismissToast, pushToast, notify, notifyError, notifyInfo }
}

export { ToastStack }
