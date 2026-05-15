/**
 * Tool-layer enums (formats, output kinds, etc).
 */

/** Output format for the export-query-to-file tool. */
export const ExportFormat = {
  Csv:   "csv",
  Tsv:   "tsv",
  Json:  "json",
  Jsonl: "jsonl",
  Txt:   "txt",
} as const

export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat]

export const EXPORT_FORMATS: ReadonlyArray<ExportFormat> = Object.values(ExportFormat)

export const isExportFormat = (value: unknown): value is ExportFormat =>
  typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value)
