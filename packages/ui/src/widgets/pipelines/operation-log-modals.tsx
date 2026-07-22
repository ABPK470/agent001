/**
 * Pipelines (operation-log) modal host.
 *
 * Overlays are visually local to this widget (anchored to host bounds) but
 * portaled to document.body so WidgetShell overflow/transform cannot clip them.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { ToolCallModal } from "../chat/ToolCallModal"
import type { ToolIoDetails } from "../chat/tool-call-io"
import { SqlTraceModal } from "../sync/trace/SqlTraceModal"
import type { SqlTraceFields } from "../sync/trace/sync-sql-trace"

type OpLogModalsContextValue = {
  openSqlTrace: (fields: SqlTraceFields) => void
  openToolIo: (io: ToolIoDetails) => void
  hostRef: RefObject<HTMLDivElement | null>
}

const OpLogModalsContext = createContext<OpLogModalsContextValue | null>(null)

export function OperationLogModalsProvider({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [sqlFields, setSqlFields] = useState<SqlTraceFields | null>(null)
  const [toolIo, setToolIo] = useState<ToolIoDetails | null>(null)

  const closeSql = useCallback(() => setSqlFields(null), [])
  const closeToolIo = useCallback(() => setToolIo(null), [])

  const openSqlTrace = useCallback((fields: SqlTraceFields) => {
    setToolIo(null)
    setSqlFields(fields)
  }, [])

  const openToolIo = useCallback((io: ToolIoDetails) => {
    setSqlFields(null)
    setToolIo(io)
  }, [])

  const value = useMemo(
    () => ({ openSqlTrace, openToolIo, hostRef }),
    [openSqlTrace, openToolIo],
  )

  return (
    <OpLogModalsContext.Provider value={value}>
      <div ref={hostRef} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {children}
        {sqlFields && (
          <SqlTraceModal
            host="local"
            hostRef={hostRef}
            fields={sqlFields}
            onClose={closeSql}
          />
        )}
        {toolIo && (
          <ToolCallModal
            host="local"
            hostRef={hostRef}
            io={toolIo}
            onClose={closeToolIo}
          />
        )}
      </div>
    </OpLogModalsContext.Provider>
  )
}

function useOpLogModals(): OpLogModalsContextValue {
  const ctx = useContext(OpLogModalsContext)
  if (!ctx) {
    const emptyRef = { current: null } as RefObject<HTMLDivElement | null>
    return {
      openSqlTrace: () => {
        console.warn("useOpLogOpenSqlTrace: OperationLogModalsProvider is missing")
      },
      openToolIo: () => {
        console.warn("useOpLogOpenToolIo: OperationLogModalsProvider is missing")
      },
      hostRef: emptyRef,
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

export function useOpLogModalHostRef(): OpLogModalsContextValue["hostRef"] {
  return useOpLogModals().hostRef
}
