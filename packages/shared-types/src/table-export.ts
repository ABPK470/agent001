/**
 * Chat answer table export — one vocabulary, one shape.
 *
 * Product verb: Export (CSV / JSON file to the user's browser).
 * Copy is clipboard-only and is not an export.
 *
 * Tables are addressed by stable 0-based index among markdown `|…|` tables
 * in the run answer. The agent tool `export_query_to_file` is a different
 * path (full SQL → sandbox file); do not conflate the two.
 */

export type TableExportFormat = "csv" | "json"

export interface AnswerTable {
  index: number
  title: string
  headers: string[]
  rows: string[][]
}

function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, "\"\"")}"`
  }
  return value
}

function parseMarkdownTableRow(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

function isMarkdownTableSeparator(row: string): boolean {
  return /^\|[\s\-|:]+\|$/.test(row.trim())
}

function titleFromHeading(line: string): string | null {
  const match = line.match(/^(#{1,3})\s+(.+)/)
  return match ? match[2].trim() : null
}

function defaultTableTitle(index: number, headers: string[]): string {
  const cols = headers.filter(Boolean).slice(0, 3).join(", ")
  return cols ? `Table ${index + 1} (${cols})` : `Table ${index + 1}`
}

/** Extract markdown pipe tables from a completed agent answer, in order. */
export function extractAnswerTables(answer: string): AnswerTable[] {
  const lines = answer.split("\n")
  const tables: AnswerTable[] = []
  let i = 0
  let lastHeading: string | null = null

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }

    if (line.startsWith("```")) {
      i++
      while (i < lines.length && !lines[i].startsWith("```")) i++
      if (i < lines.length) i++
      lastHeading = null
      continue
    }

    const heading = titleFromHeading(line)
    if (heading) {
      lastHeading = heading
      i++
      continue
    }

    if (line.trimStart().startsWith("|") && line.includes("|", 1)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i])
        i++
      }
      const dataLines = tableLines.filter((row) => !isMarkdownTableSeparator(row))
      if (dataLines.length >= 2) {
        const headers = parseMarkdownTableRow(dataLines[0])
        const rows = dataLines
          .slice(1)
          .map(parseMarkdownTableRow)
          .filter((row) => row.length === headers.length)
        const index = tables.length
        tables.push({
          index,
          title: lastHeading?.trim() || defaultTableTitle(index, headers),
          headers,
          rows,
        })
      }
      lastHeading = null
      continue
    }

    lastHeading = null
    i++
  }

  return tables
}

export function serializeAnswerTableCsv(table: Pick<AnswerTable, "headers" | "rows">): string {
  return [
    table.headers.map(escapeCsvCell).join(","),
    ...table.rows.map((row) => row.map((cell) => escapeCsvCell(cell ?? "")).join(",")),
  ].join("\n")
}

/** JSON export shape — single or many tables under one run. */
export function serializeAnswerTablesJson(runId: string, tables: AnswerTable[]): string {
  return JSON.stringify(
    {
      runId,
      tables: tables.map((table) => ({
        index: table.index,
        title: table.title,
        headers: table.headers,
        rows: table.rows,
      })),
    },
    null,
    2,
  )
}

export function tableExportFilename(
  runId: string,
  format: TableExportFormat,
  opts: { tableIndex?: number; multi?: boolean },
): string {
  const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const short = runId.slice(0, 8)
  if (format === "json" && opts.multi) {
    return `tables-${dateTag}-${short}.json`
  }
  const index = opts.tableIndex ?? 0
  return `table-${dateTag}-${short}-${index}.${format}`
}

export interface TableExportRequest {
  format: TableExportFormat
  tableIndexes: number[]
}

export function isTableExportFormat(value: unknown): value is TableExportFormat {
  return value === "csv" || value === "json"
}

/**
 * Resolve which tables to export. Named outcomes — never silent partial picks.
 * CSV always means exactly one table.
 */
export function resolveTablesForExport(
  answer: string | null | undefined,
  request: TableExportRequest,
):
  | { ok: true; tables: AnswerTable[] }
  | { ok: false; error: string } {
  if (!isTableExportFormat(request.format)) {
    return { ok: false, error: "format must be csv or json" }
  }
  if (!Array.isArray(request.tableIndexes) || request.tableIndexes.length === 0) {
    return { ok: false, error: "tableIndexes must be a non-empty array" }
  }
  if (request.format === "csv" && request.tableIndexes.length !== 1) {
    return { ok: false, error: "CSV exports exactly one table at a time" }
  }

  const all = extractAnswerTables(answer ?? "")
  if (all.length === 0) {
    return { ok: false, error: "No markdown tables in this run answer" }
  }

  const seen = new Set<number>()
  const selected: AnswerTable[] = []
  for (const raw of request.tableIndexes) {
    if (!Number.isInteger(raw) || raw < 0) {
      return { ok: false, error: `Invalid table index: ${String(raw)}` }
    }
    if (seen.has(raw)) {
      return { ok: false, error: `Duplicate table index: ${raw}` }
    }
    seen.add(raw)
    const table = all.find((t) => t.index === raw)
    if (!table) {
      return { ok: false, error: `Table index ${raw} not found (answer has ${all.length})` }
    }
    selected.push(table)
  }

  return { ok: true, tables: selected }
}
