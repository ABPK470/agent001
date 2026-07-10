export const CELL_PREVIEW_MAX_LEN = 80

export type SampleRowShape = {
  values?: Record<string, unknown>
  newValues?: Record<string, unknown>
  oldValues?: Record<string, unknown>
  changedColumns?: string[]
}

export type SampleRowDetail = {
  table: string
  kind: "insert" | "update" | "delete"
  rowIndex: number
  sample: SampleRowShape
}

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

/** All column names present on a sample row, sorted for stable display. */
export function sampleRowColumns(sample: SampleRowShape): string[] {
  const seen = new Set<string>()
  const columns: string[] = []
  const add = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key)
      columns.push(key)
    }
  }
  for (const key of Object.keys(sample.values ?? {})) add(key)
  for (const key of Object.keys(sample.newValues ?? {})) add(key)
  for (const key of Object.keys(sample.oldValues ?? {})) add(key)
  return columns.sort((a, b) => a.localeCompare(b))
}

/** Split update columns into changed vs unchanged for diff-first layout. */
export function partitionSampleRowColumns(sample: SampleRowShape): {
  changed: string[]
  unchanged: string[]
} {
  const changedSet = new Set(sample.changedColumns ?? [])
  const changed: string[] = []
  const unchanged: string[] = []
  for (const column of sampleRowColumns(sample)) {
    if (changedSet.has(column)) changed.push(column)
    else unchanged.push(column)
  }
  return { changed, unchanged }
}

export function sampleRowDetailTitle(kind: SampleRowDetail["kind"]): string {
  if (kind === "insert") return "Insert row"
  if (kind === "update") return "Update row"
  return "Delete row"
}

export function sampleRowDetailSubtitle(detail: SampleRowDetail): string {
  return `${detail.table} · ${detail.kind} · row ${detail.rowIndex + 1}`
}
