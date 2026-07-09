import { X } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { createContext, useCallback, useContext, useMemo, useState } from "react"

interface Notice {
  text: string
  kind: "ok" | "err"
}

interface ConsoleContextValue {
  notice: Notice | null
  notify: (message: string) => void
  notifyError: (message: string) => void
  clearNotice: () => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)

export function ConsoleProvider({ children }: { children: ReactNode }): JSX.Element {
  const [notice, setNotice] = useState<Notice | null>(null)

  const notify = useCallback((message: string) => {
    setNotice({ text: message, kind: "ok" })
    window.setTimeout(() => setNotice((n) => (n?.text === message ? null : n)), 2200)
  }, [])

  const notifyError = useCallback((message: string) => {
    setNotice({ text: message, kind: "err" })
  }, [])

  const clearNotice = useCallback(() => setNotice(null), [])

  const value = useMemo(
    () => ({ notice, notify, notifyError, clearNotice }),
    [notice, notify, notifyError, clearNotice],
  )

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
}

/** Place inside the widget padding shell — matches entity-registry toast position. */
export function ConsoleNotice(): JSX.Element | null {
  const { notice, clearNotice } = useConsole()
  if (!notice) return null
  return (
    <div
      className={[
        "mb-2 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
        notice.kind === "err"
          ? "border-error/30 text-error"
          : "border-border-subtle text-text-muted",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate">{notice.text}</span>
      <button type="button" onClick={clearNotice} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext)
  if (!ctx) throw new Error("useConsole must be used within ConsoleProvider")
  return ctx
}
