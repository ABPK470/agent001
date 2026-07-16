/**
 * Imperative SQL trace modal host — renders outside the Operation Log React tree
 * so opening SQL does not reconcile thousands of pipeline rows on the main thread.
 */

import { createRoot, type Root } from "react-dom/client"
import { SqlTraceModal } from "./components/SqlTrace"
import type { SqlTraceFields } from "./sync-sql-trace"

let container: HTMLDivElement | null = null
let root: Root | null = null

function ensureHost(): Root {
  if (!container) {
    container = document.createElement("div")
    container.id = "sql-trace-modal-host"
    document.body.appendChild(container)
    root = createRoot(container)
  }
  return root!
}

export function closeSqlTraceModalHost(): void {
  root?.render(null)
}

export function openSqlTraceModalHost(fields: SqlTraceFields): void {
  const host = ensureHost()
  host.render(
    <SqlTraceModal
      fields={fields}
      onClose={closeSqlTraceModalHost}
      usePortal={false}
    />,
  )
}
