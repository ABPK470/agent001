/**
 * Imperative SQL trace modal host — renders outside the Operation Log React tree
 * so opening SQL does not reconcile thousands of pipeline rows on the main thread.
 */

import { createRoot, type Root } from "react-dom/client"
import { SqlTraceModal } from "./components/SqlTraceModal"
import type { SqlTraceFields } from "./sync-sql-trace"

let container: HTMLDivElement | null = null
let root: Root | null = null
let openCount = 0

function ensureHost(): Root {
  if (!container) {
    container = document.createElement("div")
    container.id = "sql-trace-modal-host"
    document.body.appendChild(container)
    root = createRoot(container)
  }
  return root!
}

/** While true, Operation Log SSE head-refresh is paused to keep the main thread responsive. */
export function isSqlTraceModalOpen(): boolean {
  return openCount > 0
}

function snapshotFields(fields: SqlTraceFields): SqlTraceFields {
  const sql = typeof fields.sql === "string" ? fields.sql : ""
  return {
    label: fields.label,
    connection: fields.connection,
    sql: sql.length > 4_000 ? `${sql.slice(0, 4_000)}… [+${sql.length - 4_000} chars]` : sql,
    sqlLength: fields.sqlLength,
    sqlLogId: fields.sqlLogId ?? null,
    rowCount: fields.rowCount ?? null,
    durationMs: fields.durationMs ?? null,
    error: fields.error ?? null,
    scope: fields.scope ?? null,
  }
}

export function closeSqlTraceModalHost(): void {
  openCount = 0
  root?.render(null)
}

export function openSqlTraceModalHost(fields: SqlTraceFields): void {
  const snapshot = snapshotFields(fields)
  openCount = 1
  // Yield past the click handler so the overlay can paint before any heavy work.
  window.setTimeout(() => {
    const host = ensureHost()
    host.render(
      <SqlTraceModal
        fields={snapshot}
        onClose={closeSqlTraceModalHost}
        usePortal={false}
      />,
    )
  }, 0)
}
