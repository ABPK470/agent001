/**
 * bridge-summaries.ts — one-line human labels for Bridge specs and map state.
 * Kept pure so the shell stays declarative.
 */

import type { ConnectorKindId } from "@mia/shared-types"
import { readSpecKindFor, writeSpecKindFor } from "./spec-forms"
import { isPassThrough, type TransformDraft } from "./transform-draft"

function clip(text: string, max = 56): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

export function summarizeReadSpec(kind: ConnectorKindId, bag: Record<string, unknown>): string {
  const k = readSpecKindFor(kind)
  if (!k) return "Not configured"
  if (k === "sql") {
    const sql = String(bag["sql"] ?? "").trim()
    return sql ? clip(sql) : "Enter a SQL query"
  }
  if (k === "httpApi") {
    const method = String(bag["method"] ?? "GET")
    const path = String(bag["path"] ?? "/").trim() || "/"
    return `${method} ${clip(path, 40)}`
  }
  if (k === "denodo") {
    const view = String(bag["view"] ?? "").trim()
    return view ? `View ${clip(view, 40)}` : "Choose a Denodo view"
  }
  if (k === "aqueduct") {
    const params = String(bag["params"] ?? "").trim()
    return params ? `Params ${clip(params, 36)}` : "Pipeline preview"
  }
  const path = String(bag["path"] ?? "").trim() || "/"
  const format = String(bag["format"] ?? "csv")
  return `${clip(path, 36)} · ${format}`
}

export function summarizeWriteSpec(kind: ConnectorKindId, bag: Record<string, unknown>): string {
  const k = writeSpecKindFor(kind)
  if (!k) return "Read-only connector"
  if (k === "sql") {
    const table = String(bag["table"] ?? "").trim()
    const mode = String(bag["mode"] ?? "append")
    if (!table) return "Choose a table"
    const extras: string[] = []
    if (bag["allowIdentityInsert"]) extras.push("identity")
    if (bag["relaxConstraints"]) extras.push("relax")
    return extras.length > 0
      ? `${clip(table, 28)} · ${mode} · ${extras.join("+")}`
      : `${clip(table, 36)} · ${mode}`
  }
  if (k === "httpApi") {
    const method = String(bag["method"] ?? "POST")
    const path = String(bag["path"] ?? "/").trim() || "/"
    return `${method} ${clip(path, 40)}`
  }
  const path = String(bag["path"] ?? "").trim() || "/"
  const format = String(bag["format"] ?? "csv")
  const mode = String(bag["mode"] ?? "replace")
  return `${clip(path, 32)} · ${format} · ${mode}`
}

export function summarizeMap(draft: TransformDraft): string {
  if (isPassThrough(draft)) return "Pass-through"
  const parts: string[] = []
  const cols = draft.columns.filter((c) => c.from.trim()).length
  const der = draft.derive.filter((d) => d.to.trim()).length
  const defs = draft.defaults.filter((d) => d.column.trim()).length
  const fil = draft.filters.filter((f) => f.column.trim()).length
  if (cols) parts.push(`${cols} column${cols === 1 ? "" : "s"}`)
  if (der) parts.push(`${der} derive`)
  if (defs) parts.push(`${defs} default${defs === 1 ? "" : "s"}`)
  if (fil) parts.push(`${fil} filter${fil === 1 ? "" : "s"}`)
  return parts.length > 0 ? parts.join(" · ") : "Pass-through"
}
