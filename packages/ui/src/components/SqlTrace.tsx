import { Maximize2 } from "lucide-react"
import { useState } from "react"
import { CodeBlock } from "./CodeBlock"
import { SqlTraceModal } from "./SqlTraceModal"
import { formatSqlTraceMeta, hasSqlTraceContent, readSqlTraceFields, type SqlTraceFields } from "../sync-sql-trace"

export { SqlTraceModal } from "./SqlTraceModal"

export function SqlTraceBlock({
  fields,
  compact = false,
  maxHeight = 160,
}: {
  fields: SqlTraceFields
  compact?: boolean
  maxHeight?: number
}) {
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div className={`rounded-md border border-border-subtle overflow-hidden ${compact ? "" : ""}`}>
      <div className="flex items-start justify-between gap-2 px-2.5 py-1.5 border-b border-border-subtle bg-elevated/30">
        <span className="font-mono text-text min-w-0 break-all whitespace-pre-wrap">{formatSqlTraceMeta(fields)}</span>
        {(fields.sqlLogId != null || fields.sql.trim()) && (
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 text-accent hover:text-accent-hover"
            onClick={() => setModalOpen(true)}
          >
            <Maximize2 size={12} />
            Full SQL
          </button>
        )}
      </div>
      {fields.sql.trim() && (
        <CodeBlock code={fields.sql} lang="sql" maxHeight={maxHeight} />
      )}
      {fields.error && (
        <div className="px-2.5 py-1 text-error border-t border-border-subtle break-all whitespace-pre-wrap">{fields.error}</div>
      )}
      {modalOpen && (
        <SqlTraceModal fields={fields} onClose={() => setModalOpen(false)} />
      )}
    </div>
  )
}

export function SqlTraceFromEventData({
  data,
  compact,
  maxHeight,
}: {
  data: Record<string, unknown>
  compact?: boolean
  maxHeight?: number
}) {
  const fields = readSqlTraceFields(data)
  if (!fields || !hasSqlTraceContent(fields)) return null
  return <SqlTraceBlock fields={fields} compact={compact} maxHeight={maxHeight} />
}

export function SqlTraceList({
  items,
  compact,
  onOpenSql,
}: {
  items: Array<{
    id: number
    label: string
    connection: string
    scope: string | null
    durationMs: number | null
    rowCount: number | null
    error: string | null
    sqlPreview: string
    sqlLength: number
  }>
  compact?: boolean
  onOpenSql?: (fields: SqlTraceFields) => void
}) {
  if (items.length === 0) {
    return (
      <div className="text-text py-4 text-center">
        No SQL trace recorded for this plan yet.
      </div>
    )
  }

  if (onOpenSql) {
    return (
      <div className="space-y-0.5">
        {items.map((item) => {
          const fields: SqlTraceFields = {
            label: item.scope ? `${item.label} (${item.scope})` : item.label,
            connection: item.connection,
            sql: item.sqlPreview,
            sqlLength: item.sqlLength,
            sqlLogId: item.id,
            rowCount: item.rowCount,
            durationMs: item.durationMs,
            error: item.error,
          }
          const summary = [
            `SQL ${item.label}`,
            item.connection,
            item.durationMs != null ? `${item.durationMs}ms` : null,
            item.rowCount != null ? `${item.rowCount} rows` : null,
          ].filter(Boolean).join(" · ")
          return (
            <div key={item.id} className="flex items-center gap-2 px-2 py-1 text-[0.8125rem] text-text">
              <span className="min-w-0 flex-1 break-all font-mono">{summary}</span>
              <button
                type="button"
                className="shrink-0 text-accent hover:text-accent-hover font-mono"
                onClick={() => onOpenSql(fields)}
              >
                SQL
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <SqlTraceBlock
          key={item.id}
          compact={compact}
          fields={{
            label: item.scope ? `${item.label} (${item.scope})` : item.label,
            connection: item.connection,
            sql: item.sqlPreview,
            sqlLength: item.sqlLength,
            sqlLogId: item.id,
            rowCount: item.rowCount,
            durationMs: item.durationMs,
            error: item.error,
          }}
        />
      ))}
    </div>
  )
}
