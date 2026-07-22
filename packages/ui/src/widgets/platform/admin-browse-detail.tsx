/**
 * Shared expandable detail panel for Audit / Usage browse rows.
 * Human labels + typed values — not a raw JSON dump.
 */

import type { ReactNode } from "react"

/** Preferred display order for common audit / usage keys. */
const KEY_ORDER: string[] = [
  "runId",
  "threadId",
  "agentId",
  "user",
  "displayName",
  "status",
  "model",
  "goal",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "llmCalls",
  "publishedAt",
  "publishedVersion",
  "definitionCount",
  "name",
  "fields",
  "source",
  "id",
]

const LABEL_OVERRIDES: Record<string, string> = {
  runId: "Run",
  threadId: "Thread",
  agentId: "Agent",
  displayName: "Display name",
  promptTokens: "Prompt tokens",
  completionTokens: "Completion tokens",
  totalTokens: "Total tokens",
  llmCalls: "LLM calls",
  publishedAt: "Published",
  publishedVersion: "Version",
  definitionCount: "Definitions",
  scopeId: "Scope",
  scopeType: "Scope type",
  createdAt: "Created",
  updatedAt: "Updated",
  requestedAt: "Requested",
  resolvedAt: "Resolved",
  resolvedBy: "Resolved by",
  policyName: "Policy",
  toolName: "Tool",
  actorUpn: "Actor",
  upn: "User",
}

const ISO_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

export type BrowseDetailEntry = { key: string; label: string; value: unknown }

export function humanizeBrowseKey(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key]
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
  if (!spaced) return key
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function isIsoLikeTimestamp(value: string): boolean {
  if (!ISO_LIKE.test(value.trim())) return false
  const ms = Date.parse(value.includes("T") || value.includes(" ") ? value : `${value}T00:00:00Z`)
  return Number.isFinite(ms)
}

export function formatBrowseTimestamp(value: string): string {
  const raw = value.trim()
  const normalized = raw.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(raw) || raw.includes("T")
    ? raw
    : `${raw}Z`
  const d = new Date(normalized.includes("T") || normalized.includes(" ") ? normalized : `${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function sortDetailKeys(keys: string[]): string[] {
  const rank = new Map(KEY_ORDER.map((k, i) => [k, i]))
  return keys.slice().sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra != null && rb != null) return ra - rb
    if (ra != null) return -1
    if (rb != null) return 1
    return a.localeCompare(b)
  })
}

export function buildBrowseDetailEntries(
  detail: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): BrowseDetailEntry[] {
  const merged: Record<string, unknown> = { ...extras, ...detail }
  const keys = sortDetailKeys(Object.keys(merged).filter((k) => merged[k] != null && merged[k] !== ""))
  return keys.map((key) => ({
    key,
    label: humanizeBrowseKey(key),
    value: merged[key],
  }))
}

export type BrowseValueKind = "empty" | "boolean" | "number" | "timestamp" | "id" | "text" | "list" | "object"

export function classifyBrowseValue(key: string, value: unknown): BrowseValueKind {
  if (value == null || value === "") return "empty"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number" && Number.isFinite(value)) return "number"
  if (Array.isArray(value)) return "list"
  if (typeof value === "object") return "object"
  if (typeof value === "string") {
    if (isIsoLikeTimestamp(value)) return "timestamp"
    if (/Id$/i.test(key) || key === "id" || key === "sid") return "id"
    return "text"
  }
  return "text"
}

export function formatBrowseScalar(key: string, value: unknown): string {
  const kind = classifyBrowseValue(key, value)
  switch (kind) {
    case "empty":
      return "—"
    case "boolean":
      return value ? "Yes" : "No"
    case "number":
      return Number(value).toLocaleString()
    case "timestamp":
      return formatBrowseTimestamp(String(value))
    case "id":
    case "text":
      return String(value)
    default:
      return String(value)
  }
}

export function AdminBrowseDetailPanel({
  entries,
}: {
  entries: BrowseDetailEntry[]
}): ReactNode {
  if (entries.length === 0) return null

  return (
    <div className="mb-2 ml-8 overflow-hidden rounded-xl border border-border-subtle bg-overlay-2/80">
      <dl className="divide-y divide-border-subtle">
        {entries.map((entry) => (
          <BrowseDetailRow key={entry.key} entry={entry} />
        ))}
      </dl>
    </div>
  )
}

function BrowseDetailRow({ entry }: { entry: BrowseDetailEntry }) {
  const kind = classifyBrowseValue(entry.key, entry.value)
  return (
    <div className="grid grid-cols-[minmax(7rem,9.5rem)_minmax(0,1fr)] gap-x-4 gap-y-1 px-3.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-[12px] font-medium text-text-muted">{entry.label}</dt>
      <dd className="min-w-0 text-[13px] leading-snug text-text">
        <BrowseDetailValue kind={kind} entryKey={entry.key} value={entry.value} />
      </dd>
    </div>
  )
}

function BrowseDetailValue({
  kind,
  entryKey,
  value,
}: {
  kind: BrowseValueKind
  entryKey: string
  value: unknown
}) {
  if (kind === "empty") {
    return <span className="text-text-faint">—</span>
  }
  if (kind === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>
  }
  if (kind === "number") {
    return <span className="tabular-nums">{Number(value).toLocaleString()}</span>
  }
  if (kind === "timestamp") {
    return (
      <span title={String(value)} className="text-text-secondary">
        {formatBrowseTimestamp(String(value))}
      </span>
    )
  }
  if (kind === "id") {
    return (
      <span className="break-all font-mono text-[12px] text-text-secondary" title={String(value)}>
        {String(value)}
      </span>
    )
  }
  if (kind === "list") {
    const list = value as unknown[]
    if (list.length === 0) return <span className="text-text-faint">None</span>
    const allScalar = list.every(
      (item) => item == null || ["string", "number", "boolean"].includes(typeof item),
    )
    if (allScalar) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {list.map((item, i) => (
            <span
              key={i}
              className="inline-flex max-w-full items-center rounded-md border border-border-subtle bg-base/40 px-2 py-0.5 font-mono text-[11px] text-text-secondary"
            >
              <span className="truncate">{formatBrowseScalar(entryKey, item)}</span>
            </span>
          ))}
        </div>
      )
    }
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-base/50 px-2.5 py-2 font-mono text-[11px] text-text-secondary">
        {JSON.stringify(list, null, 2)}
      </pre>
    )
  }
  if (kind === "object") {
    const obj = value as Record<string, unknown>
    const nested = buildBrowseDetailEntries(obj)
    if (nested.length === 0) {
      return <span className="text-text-faint">—</span>
    }
    // Shallow objects: nested rows. Deep/large: pretty JSON.
    const deep = nested.some((n) => {
      const k = classifyBrowseValue(n.key, n.value)
      return k === "object" || k === "list"
    })
    if (!deep && nested.length <= 12) {
      return (
        <div className="space-y-1.5">
          {nested.map((n) => (
            <div key={n.key} className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
              <span className="shrink-0 text-[12px] text-text-faint">{n.label}</span>
              <span className="min-w-0 break-words text-[12px] text-text-secondary">
                <BrowseDetailValue
                  kind={classifyBrowseValue(n.key, n.value)}
                  entryKey={n.key}
                  value={n.value}
                />
              </span>
            </div>
          ))}
        </div>
      )
    }
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-base/50 px-2.5 py-2 font-mono text-[11px] text-text-secondary">
        {JSON.stringify(obj, null, 2)}
      </pre>
    )
  }
  return <span className="break-words">{String(value)}</span>
}
