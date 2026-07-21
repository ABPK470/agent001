/**
 * Collapsible JSON tree for read-only inspection (audit logs, event payloads, etc.).
 */

import { Check, ChevronRight, Copy } from "lucide-react"
import { useCallback, useMemo, useState, type ReactNode } from "react"

export interface JsonViewerProps {
  value: unknown
  /** How many nesting levels start expanded (default 2). */
  defaultExpandDepth?: number
  maxHeight?: number
  className?: string
  copyable?: boolean
  /** Optional label shown in the toolbar (e.g. "payload"). */
  label?: string
}

function formatScalarDisplay(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return String(value)
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function previewScalar(value: unknown): string {
  return formatScalarDisplay(value)
}

function previewContainer(value: unknown[]): string {
  if (value.length === 0) return "[]"
  const head = value.slice(0, 2).map(previewScalar).join(", ")
  return value.length > 2 ? `[${head}, … +${value.length - 2}]` : `[${head}]`
}

function previewObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  if (keys.length === 0) return "{}"
  const head = keys.slice(0, 2).join(", ")
  return keys.length > 2 ? `{ ${head}, … +${keys.length - 2} }` : `{ ${head} }`
}

function JsonPrimitive({ name, value }: { name?: string; value: unknown }) {
  let valueClass = "text-text-muted"
  if (typeof value === "string") valueClass = "text-success"
  else if (typeof value === "number") valueClass = "text-warning"
  else if (typeof value === "boolean") valueClass = "text-info"
  else if (value === null) valueClass = "text-text-muted/60 italic"

  return (
    <div className="flex items-baseline gap-1 py-px font-mono text-xs leading-relaxed min-w-0">
      {name != null && (
        <>
          <span className="text-accent shrink-0">{name}</span>
          <span className="text-text-muted/50 shrink-0">:</span>
        </>
      )}
      <span className={`min-w-0 break-all whitespace-pre-wrap ${valueClass}`}>{formatScalarDisplay(value)}</span>
    </div>
  )
}

function JsonNode({
  name,
  value,
  depth,
  defaultExpandDepth,
}: {
  name?: string
  value: unknown
  depth: number
  defaultExpandDepth: number
}) {
  const isContainer = value !== null && typeof value === "object"
  const [collapsed, setCollapsed] = useState(depth >= defaultExpandDepth)

  if (!isContainer) {
    return <JsonPrimitive name={name} value={value} />
  }

  const isArray = Array.isArray(value)
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((entry, index) => [String(index), entry])
    : Object.entries(value as Record<string, unknown>)

  const collapsedPreview = isArray
    ? previewContainer(value as unknown[])
    : previewObject(value as Record<string, unknown>)

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex items-start gap-0.5 w-full text-left py-px font-mono text-xs leading-relaxed hover:bg-overlay-2/40 rounded -mx-1 px-1"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 mt-0.5 text-text-muted/60 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        {name != null && (
          <>
            <span className="text-accent shrink-0">{name}</span>
            <span className="text-text-muted/50 shrink-0">:</span>
          </>
        )}
        {collapsed ? (
          <span className="text-text-muted/70 min-w-0 break-all">{collapsedPreview}</span>
        ) : (
          <span className="text-text-muted/50">{isArray ? "[" : "{"}</span>
        )}
      </button>
      {!collapsed && (
        <div className="ml-3 pl-2 border-l border-border-subtle/80 space-y-0.5 my-0.5">
          {entries.length === 0 ? (
            <div className="text-xs font-mono text-text-muted/50 py-px">{isArray ? "empty" : "empty"}</div>
          ) : (
            entries.map(([key, child]) => (
              <JsonNode
                key={key}
                name={isArray ? `[${key}]` : key}
                value={child}
                depth={depth + 1}
                defaultExpandDepth={defaultExpandDepth}
              />
            ))
          )}
          <div className="text-xs font-mono text-text-muted/50 py-px">{isArray ? "]" : "}"}</div>
        </div>
      )}
    </div>
  )
}

export function JsonViewer({
  value,
  defaultExpandDepth = 2,
  maxHeight = 320,
  className = "",
  copyable = true,
  label,
}: JsonViewerProps) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => serialize(value), [value])

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  let body: ReactNode
  if (value === null || typeof value !== "object") {
    body = <JsonPrimitive value={value} />
  } else {
    body = (
      <JsonNode
        value={value}
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
      />
    )
  }

  return (
    <div
      className={`rounded border border-border-subtle bg-base/80 overflow-hidden ${className}`}
    >
      {(copyable || label) && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border-subtle/80 bg-overlay-1/60">
          {label ? (
            <span className="text-[10px] uppercase tracking-wide text-text-muted/70 font-mono">
              {label}
            </span>
          ) : (
            <span />
          )}
          {copyable && (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-text-muted hover:text-text hover:bg-overlay-2 rounded transition-colors ml-auto"
              title="Copy JSON"
            >
              {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
      <div
        className="px-2 py-1.5 overflow-auto"
        style={{ maxHeight }}
      >
        {body}
      </div>
    </div>
  )
}
