/**
 * Full-SQL modal for sync traces.
 * Shows event preview immediately; fetches sync_sql_log only when sqlLogId
 * is present and the preview is missing or truncated.
 *
 * host="local" — pin to widget hostRef (Pipelines)
 * host="viewport" — portal full-screen (default)
 */

import { X } from "lucide-react"
import type { RefObject } from "react"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { CodeBlock } from "../../../components/CodeBlock"
import {
  type ModalHost,
  ViewportOverlay,
  WidgetLocalOverlay,
} from "../../widget-local-overlay"
import { fetchSqlLogText, peekSqlLogText } from "./sync-sql-log-cache"
import { formatSqlTraceMeta, normalizeSqlTraceText, type SqlTraceFields } from "./sync-sql-trace"

function previewLooksComplete(preview: string, sqlLength?: number): boolean {
  const trimmed = preview.trim()
  if (!trimmed) return false
  if (sqlLength == null || sqlLength <= 0) return true
  return trimmed.length >= sqlLength
}

function SqlTraceModalBody({
  fields,
  onClose,
  code,
  loading,
  error,
  codeMaxHeight,
}: {
  fields: SqlTraceFields
  onClose: () => void
  code: string
  loading: boolean
  error: string | null
  codeMaxHeight: number
}) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="break-all font-medium text-text">{fields.label}</div>
          <div className="break-all font-mono text-[0.8125rem] text-text-muted">
            {formatSqlTraceMeta(fields)}
          </div>
        </div>
        <button type="button" className="text-text hover:opacity-80" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <div className="py-8 text-center text-text">Loading full SQL…</div>
        ) : error ? (
          <div className="whitespace-pre-wrap break-all py-4 text-error">{error}</div>
        ) : (
          <CodeBlock code={code} lang="sql" maxHeight={codeMaxHeight} />
        )}
        {fields.error && (
          <div className="mt-3 whitespace-pre-wrap break-all text-error">{fields.error}</div>
        )}
      </div>
    </>
  )
}

export function SqlTraceModal({
  fields,
  onClose,
  host = "viewport",
  hostRef,
}: {
  fields: SqlTraceFields
  onClose: () => void
  host?: ModalHost
  hostRef?: RefObject<HTMLElement | null>
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

  const body = (
    <SqlTraceModalBody
      fields={fields}
      onClose={onClose}
      code={code}
      loading={loading}
      error={error}
      codeMaxHeight={host === "local" ? 480 : 720}
    />
  )

  if (host === "local") {
    if (!hostRef) {
      console.warn("SqlTraceModal host=local requires hostRef")
      return null
    }
    return (
      <WidgetLocalOverlay hostRef={hostRef} onClose={onClose} aria-label="SQL trace">
        {body}
      </WidgetLocalOverlay>
    )
  }

  return createPortal(
    <ViewportOverlay onClose={onClose} aria-label="SQL trace">
      {body}
    </ViewportOverlay>,
    document.body,
  )
}
