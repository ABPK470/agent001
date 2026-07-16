import { createPortal } from "react-dom"
import { Maximize2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { CodeBlock } from "./CodeBlock"
import { fetchSqlLogText, peekSqlLogText } from "../sync-sql-log-cache"
import { formatSqlTraceMeta, hasSqlTraceContent, normalizeSqlTraceText, readSqlTraceFields, type SqlTraceFields } from "../sync-sql-trace"

const SQL_HIGHLIGHT_MAX_CHARS = 48_000

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

export function SqlTraceModal({
  fields,
  onClose,
}: {
  fields: SqlTraceFields
  onClose: () => void
}) {
  const previewSql = normalizeSqlTraceText(fields.sql)
  const [fullSql, setFullSql] = useState(previewSql)
  const [loading, setLoading] = useState(
    fields.sqlLogId != null && peekSqlLogText(fields.sqlLogId) == null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (fields.sqlLogId == null) {
      setFullSql(previewSql)
      setLoading(false)
      return
    }
    const hit = peekSqlLogText(fields.sqlLogId)
    if (hit != null) {
      setFullSql(normalizeSqlTraceText(hit))
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchSqlLogText(fields.sqlLogId)
      .then((sql) => {
        if (!cancelled) {
          setFullSql(normalizeSqlTraceText(sql))
          setError(null)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setFullSql(previewSql)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fields.sqlLogId, previewSql])

  const resolvedSql =
    normalizeSqlTraceText(fullSql).trim() ||
    previewSql.trim() ||
    (fields.sqlLength != null && fields.sqlLength > 0
      ? `-- SQL text is not available in this event (${fields.sqlLength} chars were executed)`
      : "-- no SQL recorded for this step")

  const highlightSql = resolvedSql.length <= SQL_HIGHLIGHT_MAX_CHARS

  const body = loading
    ? <div className="text-text py-8 text-center">Loading full SQL…</div>
    : error
      ? <div className="text-error py-4 break-all whitespace-pre-wrap">{error}</div>
      : (
        <CodeBlock
          code={resolvedSql}
          lang={highlightSql ? "sql" : "text"}
          maxHeight={720}
        />
      )

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[min(90dvh,900px)] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="font-medium text-text break-all">{fields.label}</div>
            <div className="font-mono text-text break-all">{formatSqlTraceMeta({ ...fields, sql: fullSql })}</div>
          </div>
          <button type="button" className="text-text hover:opacity-80" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {body}
          {fields.error && (
            <div className="mt-3 text-error break-all whitespace-pre-wrap">{fields.error}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
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
  /** When set, rows open SQL via shared modal instead of inline blocks. */
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
