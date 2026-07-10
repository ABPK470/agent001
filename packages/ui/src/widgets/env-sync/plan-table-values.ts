export const CELL_PREVIEW_MAX_LEN = 80

/** Compact table preview — matches legacy `formatValue` behavior. */
export function formatCellPreview(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "object") return JSON.stringify(value)
  const text = String(value)
  return text.length > CELL_PREVIEW_MAX_LEN ? `${text.slice(0, 77)}…` : text
}

/** Full value for the detail modal — never truncated; JSON pretty-printed when possible. */
export function formatCellFull(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  const text = String(value)
  const trimmed = text.trim()
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  return text
}

export function isCellPreviewTruncated(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === "object") return false
  return String(value).length > CELL_PREVIEW_MAX_LEN
}

export type SampleValueDetail = {
  table: string
  column: string
  kind: "insert" | "update" | "delete"
  variant: "value" | "old" | "new"
  value: unknown
}

export function sampleValueDetailLabel(detail: SampleValueDetail): string {
  const kindLabel = detail.kind
  if (detail.variant === "old") return `${detail.table} · ${kindLabel} · previous value`
  if (detail.variant === "new") return `${detail.table} · ${kindLabel} · new value`
  return `${detail.table} · ${kindLabel}`
}
