/**
 * Pure Audit Log view helpers — verb accents, target, 1-line summary, change hints,
 * and forensic before/after / version-ref parsing for the inspector.
 */

import type { AdminAuditItem } from "../../client/index"

export type ActionVerbKind = "create" | "update" | "delete" | "deny" | "other"

export type AuditChangeHint = {
  label: string
  value: string
}

export type AuditVersionRef = {
  kind: "entity_version" | "strategy_version" | "catalog_version"
  tenantId?: string
  id?: string
  version?: number
  prevVersion?: number
  catalogVersion?: number
  againstCatalogVersion?: number
}

export type AuditDiffSides =
  | { mode: "embedded"; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
  | { mode: "ref"; ref: AuditVersionRef }
  | { mode: "none" }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseVersionRef(raw: unknown): AuditVersionRef | null {
  if (!isPlainObject(raw)) return null
  const kind = raw.kind
  if (kind !== "entity_version" && kind !== "strategy_version" && kind !== "catalog_version") {
    return null
  }
  const ref: AuditVersionRef = { kind }
  if (typeof raw.tenantId === "string") ref.tenantId = raw.tenantId
  if (typeof raw.id === "string") ref.id = raw.id
  if (typeof raw.version === "number") ref.version = raw.version
  if (typeof raw.prevVersion === "number") ref.prevVersion = raw.prevVersion
  if (typeof raw.catalogVersion === "number") ref.catalogVersion = raw.catalogVersion
  if (typeof raw.againstCatalogVersion === "number") {
    ref.againstCatalogVersion = raw.againstCatalogVersion
  }
  return ref
}

/** Parse forensic sides from audit detail — embedded before/after or version-store ref. */
export function auditDiffSides(detail: Record<string, unknown>): AuditDiffSides {
  const ref = parseVersionRef(detail.ref)
  if (ref) return { mode: "ref", ref }

  const hasBefore = "before" in detail
  const hasAfter = "after" in detail
  if (!hasBefore && !hasAfter) return { mode: "none" }

  const before =
    detail.before === null ? null : isPlainObject(detail.before) ? detail.before : null
  const after = detail.after === null ? null : isPlainObject(detail.after) ? detail.after : null
  if (before == null && after == null && detail.before !== null && detail.after !== null) {
    return { mode: "none" }
  }
  return { mode: "embedded", before, after }
}

export function stringifyAuditJson(value: Record<string, unknown> | null): string | null {
  if (value == null) return null
  try {
    return `${JSON.stringify(value, null, 2)}\n`
  } catch {
    return null
  }
}

function detailString(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key]
  if (typeof v === "string" && v.trim()) return v.trim()
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return null
}

function fieldKeys(detail: Record<string, unknown>): string[] {
  const fields = detail.fields
  if (Array.isArray(fields)) {
    return fields.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
  }
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    return Object.keys(fields as Record<string, unknown>)
  }
  return []
}

export function actionVerbKind(action: string): ActionVerbKind {
  const a = action.toLowerCase()
  if (a.includes("blocked") || a.includes("denied") || a.endsWith(".deny")) return "deny"
  if (
    a.includes(".delete") ||
    a.endsWith("delete") ||
    a.includes(".revoke") ||
    a.endsWith("revoke") ||
    a.includes(".remove")
  ) {
    return "delete"
  }
  if (
    a.includes(".create") ||
    a.endsWith("create") ||
    a.includes(".published") ||
    a.endsWith("published") ||
    a.includes(".publish")
  ) {
    return "create"
  }
  if (
    a.includes(".update") ||
    a.endsWith("update") ||
    a.includes(".modify") ||
    a.includes(".patch") ||
    a.includes(".set")
  ) {
    return "update"
  }
  return "other"
}

/** Muted text accent for action column — theme tokens only. */
export function actionVerbClass(kind: ActionVerbKind): string {
  switch (kind) {
    case "create":
      return "text-success"
    case "update":
      return "text-info"
    case "delete":
      return "text-warning"
    case "deny":
      return "text-error"
    default:
      return "text-text"
  }
}

export function auditTarget(entry: AdminAuditItem): string {
  const name = detailString(entry.detail, "name")
  if (name) return name
  const id = detailString(entry.detail, "id")
  if (id) return id
  if (entry.scopeId?.trim()) return entry.scopeId.trim()
  if (entry.threadTitle?.trim()) return entry.threadTitle.trim()
  if (entry.runId?.trim()) return entry.runId.trim()
  return "—"
}

function quote(s: string): string {
  return `"${s}"`
}

export function auditSummary(entry: AdminAuditItem): string {
  const { action, detail } = entry
  const kind = actionVerbKind(action)
  const name = detailString(detail, "name")
  const keys = fieldKeys(detail)
  const lower = action.toLowerCase()

  if (lower.includes("sync_env") && kind === "create" && name) {
    const mode = detailString(detail, "defaultAccessMode")
    return mode
      ? `Created environment ${quote(name)} (mode: ${mode})`
      : `Created environment ${quote(name)}`
  }
  if (lower.includes("policy") && kind === "delete" && name) {
    return `Deleted policy ${quote(name)}`
  }
  if (lower.includes("policy") && kind === "create" && name) {
    const effect = detailString(detail, "effect")
    return effect
      ? `Created policy ${quote(name)} (${effect})`
      : `Created policy ${quote(name)}`
  }
  if (kind === "create" && name) {
    return `Created ${quote(name)}`
  }
  if (kind === "delete" && name) {
    return `Deleted ${quote(name)}`
  }
  if (kind === "update") {
    if (keys.length === 1) return `Updated ${keys[0]}`
    if (keys.length > 1) {
      const preview = keys.slice(0, 3).join(", ")
      return keys.length > 3
        ? `${keys.length} fields changed (${preview}…)`
        : `${keys.length} fields changed (${preview})`
    }
    if (name) return `Updated ${quote(name)}`
  }
  if (kind === "deny") {
    const tool = detailString(detail, "tool") ?? detailString(detail, "reason")
    return tool ? `Denied — ${tool}` : "Denied"
  }

  // Fallback: first useful scalars, never dump JSON.
  const bits: string[] = []
  if (name) bits.push(name)
  const effect = detailString(detail, "effect")
  if (effect) bits.push(effect)
  if (keys.length > 0) bits.push(keys.slice(0, 2).join(", "))
  if (bits.length > 0) return bits.join(" · ")
  return action
}

export function auditChangeHints(detail: Record<string, unknown>): AuditChangeHint[] {
  const hints: AuditChangeHint[] = []
  const keys = fieldKeys(detail)
  if (keys.length > 0) {
    hints.push({
      label: keys.length === 1 ? "Field" : "Fields",
      value: keys.join(", "),
    })
    const fields = detail.fields
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      for (const key of keys.slice(0, 12)) {
        const v = (fields as Record<string, unknown>)[key]
        if (v == null || typeof v === "object") continue
        hints.push({ label: key, value: String(v) })
      }
    }
  }

  for (const key of ["name", "effect", "condition", "source", "id", "defaultAccessMode", "tool", "reason"]) {
    if (hints.some((h) => h.label === key)) continue
    const v = detailString(detail, key)
    if (v) hints.push({ label: key, value: v })
  }

  return hints
}

export function formatAuditWhen(ts: string): string {
  const d = new Date(ts.endsWith("Z") || ts.includes("+") ? ts : `${ts}Z`)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function formatAuditScope(entry: AdminAuditItem): string {
  if (entry.scopeId) return `${entry.scopeType} · ${entry.scopeId}`
  return entry.scopeType
}
