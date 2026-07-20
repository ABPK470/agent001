/**
 * Chat table export — UI entry to the single export path.
 *
 * Product verb: Export. Copy is clipboard-only (not Export).
 * Run-answer tables: POST /api/runs/:id/export/tables (api_request_log audit).
 * On-screen tables without a run index: local browser save of the same bytes.
 */

import {
  serializeAnswerTableCsv,
  serializeAnswerTablesJson,
  tableExportFilename,
  type AnswerTable,
  type TableExportFormat,
} from "@mia/shared-types"
import { downloadAuthenticated, downloadBlob } from "./userDownload"

export type ChatTableExportSource =
  | { kind: "run"; runId: string; tableIndex: number }
  | { kind: "local"; title?: string }

export async function exportChatTable(opts: {
  source: ChatTableExportSource
  format: TableExportFormat
  headers: string[]
  rows: string[][]
}): Promise<{ filename: string; bytes: number }> {
  const { source, format, headers, rows } = opts

  if (source.kind === "run") {
    const fallback = tableExportFilename(source.runId, format, {
      tableIndex: source.tableIndex,
    })
    return downloadAuthenticated(
      `/api/runs/${encodeURIComponent(source.runId)}/export/tables`,
      fallback,
      {
        method: "POST",
        body: JSON.stringify({
          format,
          tableIndexes: [source.tableIndex],
        }),
      },
    )
  }

  const table: AnswerTable = {
    index: 0,
    title: source.title?.trim() || "Table",
    headers,
    rows,
  }
  const body =
    format === "csv"
      ? serializeAnswerTableCsv(table)
      : serializeAnswerTablesJson("local", [table])
  const filename = tableExportFilename("local", format, { tableIndex: 0 })
  const blob = new Blob([body], {
    type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
  })
  downloadBlob(blob, filename)
  return { filename, bytes: blob.size }
}

export async function exportChatTablesJson(opts: {
  runId: string
  tableIndexes: number[]
}): Promise<{ filename: string; bytes: number }> {
  const multi = opts.tableIndexes.length > 1
  const fallback = tableExportFilename(opts.runId, "json", {
    tableIndex: multi ? undefined : opts.tableIndexes[0],
    multi,
  })
  return downloadAuthenticated(
    `/api/runs/${encodeURIComponent(opts.runId)}/export/tables`,
    fallback,
    {
      method: "POST",
      body: JSON.stringify({
        format: "json",
        tableIndexes: opts.tableIndexes,
      }),
    },
  )
}

export async function copyChatTableCsv(headers: string[], rows: string[][]): Promise<void> {
  const csv = serializeAnswerTableCsv({ headers, rows })
  await navigator.clipboard.writeText(csv)
}
