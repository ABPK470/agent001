import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { openSqlTraceModalHost } from "./sql-trace-modal-host"
import type { SqlTraceFields } from "./sync-sql-trace"

type OpLogModalsContextValue = {
  openSqlTrace: (fields: SqlTraceFields) => void
}

const OpLogModalsContext = createContext<OpLogModalsContextValue | null>(null)

export function OperationLogModalsProvider({ children }: { children: ReactNode }) {
  const openSqlTrace = useCallback((fields: SqlTraceFields) => {
    openSqlTraceModalHost(fields)
  }, [])

  const value = useMemo(() => ({ openSqlTrace }), [openSqlTrace])

  return (
    <OpLogModalsContext.Provider value={value}>
      {children}
    </OpLogModalsContext.Provider>
  )
}

export function useOpLogOpenSqlTrace(): OpLogModalsContextValue["openSqlTrace"] {
  const ctx = useContext(OpLogModalsContext)
  if (!ctx) {
    return () => {
      console.warn("useOpLogOpenSqlTrace: OperationLogModalsProvider is missing")
    }
  }
  return ctx.openSqlTrace
}
