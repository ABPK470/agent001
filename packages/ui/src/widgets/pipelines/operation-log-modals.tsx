import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { SqlTraceModal } from "../sync/trace/SqlTraceModal"
import type { SqlTraceFields } from "../sync/trace/sync-sql-trace"

type OpLogModalsContextValue = {
  openSqlTrace: (fields: SqlTraceFields) => void
}

const OpLogModalsContext = createContext<OpLogModalsContextValue | null>(null)

export function OperationLogModalsProvider({ children }: { children: ReactNode }) {
  const [sqlFields, setSqlFields] = useState<SqlTraceFields | null>(null)
  const openSqlTrace = useCallback((fields: SqlTraceFields) => {
    setSqlFields(fields)
  }, [])

  const value = useMemo(() => ({ openSqlTrace }), [openSqlTrace])

  return (
    <OpLogModalsContext.Provider value={value}>
      {children}
      {sqlFields && (
        <SqlTraceModal fields={sqlFields} onClose={() => setSqlFields(null)} />
      )}
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
