import { AlertCircle, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type JSX } from "react"

const AUTO_DISMISS_MS = 15_000

export type ModalToast = {
  id: string
  message: string
}

export function useModalToasts(autoDismissMs = AUTO_DISMISS_MS): {
  toasts: ModalToast[]
  pushToast: (message: string) => void
  dismissToast: (id: string) => void
  clearToasts: () => void
} {
  const [toasts, setToasts] = useState<ModalToast[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback(
    (message: string) => {
      const trimmed = message.trim()
      if (!trimmed) return
      const id = crypto.randomUUID()
      setToasts((current) => [...current, { id, message: trimmed }])
      const timer = setTimeout(() => dismissToast(id), autoDismissMs)
      timersRef.current.set(id, timer)
    },
    [autoDismissMs, dismissToast],
  )

  const clearToasts = useCallback(() => {
    for (const timer of timersRef.current.values()) clearTimeout(timer)
    timersRef.current.clear()
    setToasts([])
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  return { toasts, pushToast, dismissToast, clearToasts }
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
    <div
      className="pointer-events-none absolute inset-y-3 right-3 z-30 flex w-[min(100%,20rem)] flex-col justify-end gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-error/30 bg-error/10 px-3.5 py-3 text-sm text-error shadow-lg backdrop-blur-sm"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 leading-snug">{toast.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 rounded-md p-0.5 text-error/80 transition-colors hover:bg-error/15 hover:text-error"
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
