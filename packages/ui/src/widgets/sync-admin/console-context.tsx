import type { JSX, ReactNode } from "react"
import { createContext, useCallback, useContext, useMemo } from "react"
import { ToastStack, useToasts } from "../../components/ToastStack"

interface ConsoleContextValue {
  notify: (message: string) => void
  notifyError: (message: string) => void
  notifyInfo: (message: string) => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)

export function ConsoleProvider({ children }: { children: ReactNode }): JSX.Element {
  const { toasts, pushToast, dismissToast } = useToasts({ ok: 6_000, err: 12_000, info: 6_000 })

  const notify = useCallback((message: string) => pushToast(message, "ok"), [pushToast])
  const notifyError = useCallback((message: string) => pushToast(message, "err"), [pushToast])
  const notifyInfo = useCallback((message: string) => pushToast(message, "info"), [pushToast])

  const value = useMemo(
    () => ({ notify, notifyError, notifyInfo }),
    [notify, notifyError, notifyInfo],
  )

  return (
    <ConsoleContext.Provider value={value}>
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
        {children}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </ConsoleContext.Provider>
  )
}

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext)
  if (!ctx) throw new Error("useConsole must be used within ConsoleProvider")
  return ctx
}
