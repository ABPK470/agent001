import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { CodeBlock } from "../../../components/CodeBlock"
import { fetchSqlLogText, peekSqlLogText } from "./sync-sql-log-cache"
import { formatSqlTraceMeta, normalizeSqlTraceText, type SqlTraceFields } from "./sync-sql-trace"

function previewLooksComplete(preview: string, sqlLength?: number): boolean {
  const trimmed = preview.trim()
  if (!trimmed) return false
  if (sqlLength == null || sqlLength <= 0) return true
  return trimmed.length >= sqlLength
}

/**
 * Full-SQL modal for sync traces.
 * Shows event preview immediately; fetches sync_sql_log only when sqlLogId
 * is present and the preview is missing or truncated.
 */
export function SqlTraceModal({
  fields,
  onClose,
}: {
  fields: SqlTraceFields
  onClose: () => void
}) {
  const previewSql = normalizeSqlTraceText(fields.sql)
  const cached =
    fields.sqlLogId != null ? peekSqlLogText(fields.sqlLogId) : undefined

  const [sql, setSql] = useState(() => normalizeSqlTraceText(cached ?? previewSql))
  const [loading, setLoading] = useState(
    () =>
      fields.sqlLogId != null &&
      cached == null &&
      !previewLooksComplete(previewSql, fields.sqlLength),
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)

    if (fields.sqlLogId == null) {
      setSql(previewSql)
      setLoading(false)
      return
    }

    const hit = peekSqlLogText(fields.sqlLogId)
    if (hit != null) {
      setSql(normalizeSqlTraceText(hit))
      setLoading(false)
      return
    }

    // Preview is enough — no need to block on a fetch.
    if (previewLooksComplete(previewSql, fields.sqlLength)) {
      setSql(previewSql)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(previewSql.trim().length === 0)
    if (previewSql.trim()) setSql(previewSql)

    void fetchSqlLogText(fields.sqlLogId)
      .then((text) => {
        if (!cancelled) {
          setSql(normalizeSqlTraceText(text))
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setSql(previewSql)
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [fields.sqlLogId, fields.sqlLength, previewSql])

  const code =
    sql.trim() ||
    (fields.sqlLength != null && fields.sqlLength > 0
      ? `-- SQL text is not available in this event (${fields.sqlLength} chars were executed)`
      : "-- no SQL recorded for this step")

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[min(96vh,calc(100dvh-1rem))] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="font-medium text-text break-all">{fields.label}</div>
            <div className="font-mono text-text-muted text-[0.8125rem] break-all">
              {formatSqlTraceMeta(fields)}
            </div>
          </div>
          <button type="button" className="text-text hover:opacity-80" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {loading ? (
            <div className="text-text py-8 text-center">Loading full SQL…</div>
          ) : error ? (
            <div className="text-error py-4 break-all whitespace-pre-wrap">{error}</div>
          ) : (
            <CodeBlock code={code} lang="sql" maxHeight={720} />
          )}
          {fields.error && (
            <div className="mt-3 text-error break-all whitespace-pre-wrap">{fields.error}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
