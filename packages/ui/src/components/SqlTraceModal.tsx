import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { memo, useEffect, useMemo, useState } from "react"
import { CodeBlock } from "./CodeBlock"
import { fetchSqlLogText, peekSqlLogText } from "../sync-sql-log-cache"
import { formatSqlTraceMeta, normalizeSqlTraceText, type SqlTraceFields } from "../sync-sql-trace"

const SQL_DISPLAY_MAX_CHARS = 32_000

function capSqlForDisplay(sql: string): string {
  if (sql.length <= SQL_DISPLAY_MAX_CHARS) return sql
  const omitted = sql.length - SQL_DISPLAY_MAX_CHARS
  return `${sql.slice(0, SQL_DISPLAY_MAX_CHARS)}\n\n-- … ${omitted.toLocaleString()} more chars omitted --`
}

function sqlPreviewIsComplete(preview: string, sqlLength?: number): boolean {
  const trimmed = preview.trim()
  if (!trimmed) return false
  if (sqlLength == null || sqlLength <= 0) return true
  return trimmed.length >= sqlLength
}

export const SqlTraceModal = memo(function SqlTraceModal({
  fields,
  onClose,
  usePortal = true,
}: {
  fields: SqlTraceFields
  onClose: () => void
  usePortal?: boolean
}) {
  const previewSql = capSqlForDisplay(normalizeSqlTraceText(fields.sql))
  const previewReady = previewSql.trim().length > 0
  const previewComplete = sqlPreviewIsComplete(previewSql, fields.sqlLength)
  const cachedFull =
    fields.sqlLogId != null ? peekSqlLogText(fields.sqlLogId) : undefined

  const [displaySql, setDisplaySql] = useState(() =>
    capSqlForDisplay(normalizeSqlTraceText(cachedFull ?? previewSql)),
  )
  const [loading, setLoading] = useState(
    () => !previewReady && fields.sqlLogId != null && cachedFull == null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (fields.sqlLogId == null) {
      setDisplaySql(capSqlForDisplay(previewSql))
      setLoading(false)
      return
    }
    const hit = peekSqlLogText(fields.sqlLogId)
    if (hit != null) {
      setDisplaySql(capSqlForDisplay(normalizeSqlTraceText(hit)))
      setLoading(false)
      return
    }
    if (previewReady) {
      setDisplaySql(capSqlForDisplay(previewSql))
      setLoading(false)
      if (previewComplete) return
    }
    let cancelled = false
    if (!previewReady) setLoading(true)
    void fetchSqlLogText(fields.sqlLogId)
      .then((sql) => {
        if (!cancelled) {
          setDisplaySql(capSqlForDisplay(normalizeSqlTraceText(sql)))
          setError(null)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setDisplaySql(capSqlForDisplay(previewSql))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fields.sqlLogId, previewSql, previewReady, previewComplete])

  const resolvedCode = useMemo(
    () =>
      displaySql.trim() ||
      (fields.sqlLength != null && fields.sqlLength > 0
        ? `-- SQL text is not available in this event (${fields.sqlLength} chars were executed)`
        : "-- no SQL recorded for this step"),
    [displaySql, fields.sqlLength],
  )

  const body = loading
    ? <div className="text-text py-8 text-center">Loading full SQL…</div>
    : error
      ? <div className="text-error py-4 break-all whitespace-pre-wrap">{error}</div>
      : <CodeBlock code={resolvedCode} lang="sql" maxHeight={720} />

  const shell = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[min(90dvh,900px)] flex flex-col rounded-lg border border-border-subtle bg-base shadow-2xl"
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
          {body}
          {fields.error && (
            <div className="mt-3 text-error break-all whitespace-pre-wrap">{fields.error}</div>
          )}
        </div>
      </div>
    </div>
  )

  return usePortal ? createPortal(shell, document.body) : shell
})
