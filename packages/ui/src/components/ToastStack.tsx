import { AlertCircle, CheckCircle2, Info, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type JSX } from "react"

export type ToastKind = "ok" | "err" | "info"

export type Toast = {
  id: string
  message: string
  kind: ToastKind
}

const DEFAULT_DISMISS_MS: Readonly<Record<ToastKind, number>> = {
  ok: 6_000,
  err: 12_000,
  info: 6_000,
}

const KIND_STYLES: Readonly<Record<ToastKind, string>> = {
  ok: "border-border-subtle bg-elevated/95 text-text shadow-lg backdrop-blur-sm",
  err: "border-error/30 bg-error/10 text-error shadow-lg backdrop-blur-sm",
  info: "border-info/30 bg-info/10 text-info shadow-lg backdrop-blur-sm",
}

const KIND_ICONS: Readonly<Record<ToastKind, typeof CheckCircle2>> = {
  ok: CheckCircle2,
  err: AlertCircle,
  info: Info,
}

export function useToasts(dismissMs: Partial<Record<ToastKind, number>> = {}): {
  toasts: Toast[]
  pushToast: (message: string, kind?: ToastKind) => void
  dismissToast: (id: string) => void
  clearToasts: () => void
} {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const dismissMsRef = useRef({ ...DEFAULT_DISMISS_MS, ...dismissMs })
  dismissMsRef.current = { ...DEFAULT_DISMISS_MS, ...dismissMs }

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback(
    (message: string, kind: ToastKind = "ok") => {
      const trimmed = message.trim()
      if (!trimmed) return
      const id = crypto.randomUUID()
      setToasts((current) => [...current, { id, message: trimmed, kind }])
      const timer = setTimeout(() => dismissToast(id), dismissMsRef.current[kind])
      timersRef.current.set(id, timer)
    },
    [dismissToast],
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

export function ToastStack({
  toasts,
  onDismiss,
  className = "pointer-events-none absolute bottom-3 right-3 z-50 flex w-[min(100%,20rem)] flex-col justify-end gap-2",
}: {
  toasts: Toast[]
  onDismiss: (id: string) => void
  className?: string
}): JSX.Element | null {
  if (toasts.length === 0) return null

  return (
    <div className={className} aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => {
        const Icon = KIND_ICONS[toast.kind]
        return (
          <div
            key={toast.id}
            role={toast.kind === "err" ? "alert" : "status"}
            className={[
              "pointer-events-auto flex items-start gap-2.5 rounded-xl border px-4 py-3.5 text-base",
              KIND_STYLES[toast.kind],
            ].join(" ")}
          >
            <Icon size={16} className="mt-0.5 shrink-0 opacity-90" aria-hidden />
            <p className="min-w-0 flex-1 leading-snug">{toast.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 rounded-md p-0.5 opacity-70 transition-opacity hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
