/**
 * Pipelines (operation-log) modal host.
 *
 * Overlays stay inside the widget tile — absolute fill of this provider root.
 * Open from deep rows via context; never mount fixed/vh modals under overflow.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { ToolCallModal } from "../chat/ToolCallModal"
import type { ToolIoDetails } from "../chat/tool-call-io"
import { SqlTraceModal } from "../sync/trace/SqlTraceModal"
import type { SqlTraceFields } from "../sync/trace/sync-sql-trace"

type OpLogModalsContextValue = {
  openSqlTrace: (fields: SqlTraceFields) => void
  openToolIo: (io: ToolIoDetails) => void
}

const OpLogModalsContext = createContext<OpLogModalsContextValue | null>(null)

export function OperationLogModalsProvider({ children }: { children: ReactNode }) {
  const [sqlFields, setSqlFields] = useState<SqlTraceFields | null>(null)
  const [toolIo, setToolIo] = useState<ToolIoDetails | null>(null)

  const openSqlTrace = useCallback((fields: SqlTraceFields) => {
    setToolIo(null)
    setSqlFields(fields)
  }, [])

  const openToolIo = useCallback((io: ToolIoDetails) => {
    setSqlFields(null)
    setToolIo(io)
  }, [])

  const value = useMemo(() => ({ openSqlTrace, openToolIo }), [openSqlTrace, openToolIo])

  return (
    <OpLogModalsContext.Provider value={value}>
      <div className="relative h-full min-h-0 min-w-0">
        {children}
        {sqlFields && (
          <SqlTraceModal
            host="local"
            fields={sqlFields}
            onClose={() => setSqlFields(null)}
          />
        )}
        {toolIo && (
          <ToolCallModal
            host="local"
            io={toolIo}
            onClose={() => setToolIo(null)}
          />
        )}
      </div>
    </OpLogModalsContext.Provider>
  )
}

function useOpLogModals(): OpLogModalsContextValue {
  const ctx = useContext(OpLogModalsContext)
  if (!ctx) {
    return {
      openSqlTrace: () => {
        console.warn("useOpLogOpenSqlTrace: OperationLogModalsProvider is missing")
      },
      openToolIo: () => {
        console.warn("useOpLogOpenToolIo: OperationLogModalsProvider is missing")
      },
    }
  }
  return ctx
}

export function useOpLogOpenSqlTrace(): OpLogModalsContextValue["openSqlTrace"] {
  return useOpLogModals().openSqlTrace
}

export function useOpLogOpenToolIo(): OpLogModalsContextValue["openToolIo"] {
  return useOpLogModals().openToolIo
}
