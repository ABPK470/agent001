import { Maximize2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api"
import { CodeBlock } from "./CodeBlock"
import { formatSqlTraceMeta, readSqlTraceFields, type SqlTraceFields } from "../sync-sql-trace"

function needsSqlFetch(fields: SqlTraceFields): boolean {
  if (!fields.sqlLogId) return false
  const truncated = fields.sqlLength != null && fields.sqlLength > fields.sql.length
  return !fields.sql.trim() || truncated
}

/** Resolve full SQL from event preview + optional sync_sql_log id. */
export function useResolvedSql(fields: SqlTraceFields): {
  sql: string
  loading: boolean
  error: string | null
} {
  const [resolvedSql, setResolvedSql] = useState(fields.sql)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const truncated = fields.sqlLength != null && fields.sqlLength > fields.sql.length

  useEffect(() => {
    let cancelled = false
    if (!needsSqlFetch(fields)) {
      setResolvedSql(fields.sql)
      setLoading(false)
      setLoadError(null)
      return
    }
    setLoading(true)
    void api
      .getSqlLog(fields.sqlLogId!)
      .then((row) => {
        if (!cancelled) {
          setResolvedSql(row.sql)
          setLoadError(null)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e))
          setResolvedSql(fields.sql)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fields.sql, fields.sqlLogId, fields.sqlLength, truncated])

  return { sql: resolvedSql, loading, error: loadError }
}

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
  const { sql: resolvedSql, loading, error: loadError } = useResolvedSql(fields)
  const truncated = fields.sqlLength != null && fields.sqlLength > fields.sql.length
  const displayFields = { ...fields, sql: resolvedSql }

  return (
    <div className={`rounded-md border border-border-subtle overflow-hidden ${compact ? "text-xs" : "text-sm"}`}>
      <div className="flex items-start justify-between gap-2 px-2.5 py-1.5 border-b border-border-subtle bg-elevated/30">
        <div className="min-w-0 space-y-0.5">
          {resolvedSql.trim() ? (
            <span className="font-mono text-text min-w-0 break-all whitespace-pre-wrap block">{resolvedSql}</span>
          ) : loading ? (
            <span className="text-text-muted text-xs">Loading SQL…</span>
          ) : (
            <span className="font-mono text-text-muted min-w-0 break-all whitespace-pre-wrap">{formatSqlTraceMeta(displayFields)}</span>
          )}
          <span className="font-mono text-text-muted/70 text-[10px] block">{formatSqlTraceMeta(displayFields)}</span>
        </div>
        {(truncated || fields.sqlLogId) && (
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 text-accent hover:text-accent-hover text-xs"
            onClick={() => setModalOpen(true)}
          >
            <Maximize2 size={12} />
            Full SQL
          </button>
        )}
      </div>
      {loadError && (
        <div className="px-2.5 py-1 text-warning text-xs border-b border-border-subtle">{loadError}</div>
      )}
      {resolvedSql.trim() && (
        <CodeBlock code={resolvedSql} lang="sql" maxHeight={maxHeight} />
      )}
      {displayFields.error && (
        <div className="px-2.5 py-1 text-error text-xs border-t border-border-subtle break-all whitespace-pre-wrap">{displayFields.error}</div>
      )}
      {modalOpen && (
        <SqlTraceModal
          fields={displayFields}
          onClose={() => setModalOpen(false)}
        />
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
  if (!fields) return null
  return <SqlTraceBlock fields={fields} compact={compact} maxHeight={maxHeight} />
}

export function SqlTraceModal({
  fields,
  onClose,
}: {
  fields: SqlTraceFields
  onClose: () => void
}) {
  const [loading, setLoading] = useState(Boolean(fields.sqlLogId))
  const [fullSql, setFullSql] = useState(fields.sql)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!fields.sqlLogId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const row = await api.getSqlLog(fields.sqlLogId)
      setFullSql(row.sql)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [fields.sqlLogId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[min(90dvh,900px)] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text truncate">{fields.label}</div>
            <div className="text-xs font-mono text-text-muted truncate">{formatSqlTraceMeta(fields)}</div>
          </div>
          <button type="button" className="text-text-muted hover:text-text" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {loading && <div className="text-sm text-text-muted py-8 text-center">Loading full SQL…</div>}
          {!loading && error && <div className="text-sm text-error py-4">{error}</div>}
          {!loading && !error && <CodeBlock code={fullSql} lang="sql" maxHeight={9999} />}
        </div>
      </div>
    </div>
  )
}

export function SqlTraceList({
  items,
  compact,
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
}) {
  if (items.length === 0) {
    return (
      <div className="text-sm text-text-muted py-4 text-center">
        No SQL trace recorded for this plan yet.
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
