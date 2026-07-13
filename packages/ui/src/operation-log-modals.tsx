import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { SqlTraceModal } from "./components/SqlTrace"
import { OperationAuditModal } from "./operation-log-audit-modal"
import type { SqlTraceFields } from "./sync-sql-trace"
import type { OperationLogFocus } from "./store"

type OpLogModalsContextValue = {
  openSqlTrace: (fields: SqlTraceFields) => void
  openAudit: (focus: OperationLogFocus) => void
}

const OpLogModalsContext = createContext<OpLogModalsContextValue | null>(null)

export function OperationLogModalsProvider({ children }: { children: ReactNode }) {
  const [sqlFields, setSqlFields] = useState<SqlTraceFields | null>(null)
  const [auditFocus, setAuditFocus] = useState<OperationLogFocus | null>(null)
  const openSqlTrace = useCallback((fields: SqlTraceFields) => {
    setSqlFields(fields)
  }, [])
  const openAudit = useCallback((focus: OperationLogFocus) => {
    setAuditFocus(focus)
  }, [])

  const value = useMemo(() => ({ openSqlTrace, openAudit }), [openSqlTrace, openAudit])

  return (
    <OpLogModalsContext.Provider value={value}>
      {children}
      {sqlFields && <SqlTraceModal fields={sqlFields} onClose={() => setSqlFields(null)} />}
      {auditFocus && (
        <OperationAuditModal focus={auditFocus} onClose={() => setAuditFocus(null)} />
      )}
    </OpLogModalsContext.Provider>
  )
}

export function useOpLogOpenSqlTrace(): OpLogModalsContextValue["openSqlTrace"] {
  const ctx = useContext(OpLogModalsContext)
  if (!ctx) {
    throw new Error("useOpLogOpenSqlTrace must be used within OperationLogModalsProvider")
  }
  return ctx.openSqlTrace
}

export function useOpLogOpenAudit(): OpLogModalsContextValue["openAudit"] {
  const ctx = useContext(OpLogModalsContext)
  if (!ctx) {
    throw new Error("useOpLogOpenAudit must be used within OperationLogModalsProvider")
  }
  return ctx.openAudit
}
