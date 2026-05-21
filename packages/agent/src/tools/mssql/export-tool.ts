/**
 * export_query_to_file — run a SELECT and stream ALL rows to a file.
 *
 * Why this exists:
 *   When a user asks for a list of "all N rows", the LLM typically returns
 *   only ~20 rows even when asked to write to a file. This is because:
 *     • The model is conditioned to produce concise output.
 *     • Reproducing thousands of rows as a write_file argument is slow,
 *       error-prone, and consumes huge completion-token budget.
 *
 *   This tool decouples "show preview in chat" from "save full data to file":
 *   the database engine streams every row directly to disk, and the tool
 *   returns only a short summary + first-N preview to the LLM. The model
 *   never has to retype any row.
 */

import sql from "mssql"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { EXPORT_FORMATS, ExportFormat, isExportFormat } from "../../domain/enums/tools.js"
import type { Tool } from "../../types.js"
import { safePathResolved } from "../filesystem-security.js"
import { getMssqlKillSignal, getPool } from "./connection.js"
import { decorateMssqlError } from "./error-hints.js"
import { emitMssqlQualityTrace } from "./trace.js"
import { getQueryWarnings, validateQueryDetailed } from "./validation.js"

/** Maximum rows we'll write to a single file. Anything beyond this should be paginated. */
const MAX_EXPORT_ROWS = 1_000_000

/** Number of preview rows returned to the LLM in the tool result. */
const PREVIEW_ROWS = 20

function inferFormat(path: string, explicit?: string): ExportFormat {
  if (explicit) {
    const f = explicit.toLowerCase()
    if (isExportFormat(f)) return f
  }
  const lower = path.toLowerCase()
  if (lower.endsWith(".csv")) return ExportFormat.Csv
  if (lower.endsWith(".tsv")) return ExportFormat.Tsv
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return ExportFormat.Jsonl
  if (lower.endsWith(".json")) return ExportFormat.Json
  return ExportFormat.Txt
}

/** CSV-escape a single field. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s =
    v instanceof Date ? v.toISOString()
    : typeof v === "object" ? JSON.stringify(v)
    : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function tsvField(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s =
    v instanceof Date ? v.toISOString()
    : typeof v === "object" ? JSON.stringify(v)
    : String(v)
  // TSV: strip embedded tabs/newlines (best-effort)
  return s.replace(/[\t\r\n]+/g, " ")
}

function plainField(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const exportQueryToFileTool: Tool = {
  name: "export_query_to_file",
  description:
    "Run a SELECT against MSSQL and stream the FULL result set directly to a file. " +
    "Use this whenever the user asks for a complete list/export of many rows " +
    "(e.g. \"give me all 4000 dataset names\", \"export the table\", \"save the results\"). " +
    "Do NOT use query_mssql + write_file for the same purpose — that forces the model to " +
    "retype every row and almost always truncates the output. " +
    "The tool writes the full dataset to disk and returns only a short summary plus the first " +
    `${PREVIEW_ROWS} rows for you to acknowledge in chat. ` +
    "Format is inferred from the file extension (.csv/.tsv/.json/.jsonl/.txt) or pass format= explicitly. " +
    "For single-column queries, .txt produces a clean newline-separated list; otherwise prefer .csv.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "T-SQL SELECT statement. Read-only — INSERT/UPDATE/DELETE etc. are rejected.",
      },
      path: {
        type: "string",
        description: "Destination file path relative to the workspace root (e.g. 'datasets.csv'). Parent directories are created automatically.",
      },
      format: {
        type: "string",
        enum: EXPORT_FORMATS,
        description: "Optional explicit format. If omitted, inferred from the path extension. " +
          "csv = comma-separated with header. tsv = tab-separated with header. " +
          "json = single JSON array. jsonl = one JSON object per line. " +
          "txt = one row per line, fields joined with ' | ' (or just the value for single-column queries).",
      },
      connection: {
        type: "string",
        description: "Named server/pool to connect to (e.g. 'prod', 'uat'). Omit to use the default. Do NOT pass environment names as 'database'.",
      },
      database: {
        type: "string",
        description: "Optional: switch catalog database on the current server (generates USE [database]). Not for selecting environments.",
      },
    },
    required: ["query", "path"],
  },

  async execute(args) {
    const query = String(args.query ?? "").trim()
    const pathArg = String(args.path ?? "").trim()
    if (!query) return "Error: query cannot be empty."
    if (!pathArg) return "Error: path cannot be empty."

    const connectionName = args.connection ? String(args.connection).trim() : "default"

    let pool: sql.ConnectionPool
    let writeEnabled: boolean
    try {
      const result = await getPool(connectionName)
      pool = result.pool
      writeEnabled = result.entry.writeEnabled
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    // Read-only validation. We deliberately ignore the "writeEnabled" override
    // here because exporting is fundamentally a read operation — even if the
    // connection allows writes we don't want this tool used for them.
    const validation = validateQueryDetailed(query, /* writeEnabled */ false && writeEnabled)
    if (!validation.ok) {
      emitMssqlQualityTrace({
        toolMode: "export",
        phase: "blocked",
        query,
        connection: connectionName,
        database: args.database ? String(args.database).trim() : null,
        validation,
      })
      return validation.error ?? "Query blocked"
    }

    // Resolve destination path safely under the workspace root.
    let target: string
    try {
      target = await safePathResolved(pathArg)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      await mkdir(dirname(target), { recursive: true })
    } catch (err) {
      return `Error creating parent directory: ${err instanceof Error ? err.message : String(err)}`
    }

    const format = inferFormat(pathArg, args.format ? String(args.format) : undefined)

    // Optional database switch (validated like in query_mssql)
    const db = args.database ? String(args.database).trim() : null
    if (db && !/^[\w-]+$/.test(db)) return "Error: invalid database name."
    const fullQuery = db ? `USE [${db}];\n${query}` : query

    const request = pool.request()
    const killSignal = getMssqlKillSignal()
    const onKill = (): void => { request.cancel() }
    if (killSignal) {
      if (killSignal.aborted) return "Error: Tool execution cancelled"
      killSignal.addEventListener("abort", onKill, { once: true })
    }

    try {
      const startedAt = Date.now()
      const result = await request.query(fullQuery)
      const recordsets = result.recordsets as sql.IRecordSet<unknown>[]
      // Use the first non-empty recordset.
      const rs = (recordsets.find((r) => r && r.length > 0) ?? recordsets[0] ?? []) as sql.IRecordSet<unknown>
      const totalRows = rs.length
      if (totalRows === 0) {
        return `Query executed but returned 0 rows. No file written to ${pathArg}.`
      }
      if (totalRows > MAX_EXPORT_ROWS) {
        return `Error: query returned ${totalRows} rows (max ${MAX_EXPORT_ROWS}). ` +
          `Add a WHERE clause or paginate.`
      }

      const columns = Object.keys(rs[0] as Record<string, unknown>)
      const isSingleColumn = columns.length === 1

      // Build file content. Use string concatenation in chunks to keep memory OK
      // for hundreds of thousands of rows.
      const chunks: string[] = []

      if (format === ExportFormat.Csv) {
        chunks.push(columns.map(csvField).join(",") + "\n")
        for (const row of rs) {
          const r = row as Record<string, unknown>
          chunks.push(columns.map((c) => csvField(r[c])).join(",") + "\n")
        }
      } else if (format === ExportFormat.Tsv) {
        chunks.push(columns.map(tsvField).join("\t") + "\n")
        for (const row of rs) {
          const r = row as Record<string, unknown>
          chunks.push(columns.map((c) => tsvField(r[c])).join("\t") + "\n")
        }
      } else if (format === ExportFormat.Json) {
        chunks.push(JSON.stringify(rs, null, 2))
      } else if (format === ExportFormat.Jsonl) {
        for (const row of rs) chunks.push(JSON.stringify(row) + "\n")
      } else {
        // txt
        if (isSingleColumn) {
          const col = columns[0]
          for (const row of rs) {
            chunks.push(plainField((row as Record<string, unknown>)[col]) + "\n")
          }
        } else {
          chunks.push(columns.join(" | ") + "\n")
          for (const row of rs) {
            const r = row as Record<string, unknown>
            chunks.push(columns.map((c) => plainField(r[c])).join(" | ") + "\n")
          }
        }
      }

      const content = chunks.join("")
      await writeFile(target, content, "utf-8")

      // Build short preview for the LLM.
      const previewLines: string[] = []
      const previewRows = rs.slice(0, PREVIEW_ROWS)
      if (isSingleColumn) {
        const col = columns[0]
        for (const [i, row] of previewRows.entries()) {
          previewLines.push(`${i + 1}. ${plainField((row as Record<string, unknown>)[col])}`)
        }
      } else {
        previewLines.push(columns.join(" | "))
        for (const row of previewRows) {
          const r = row as Record<string, unknown>
          previewLines.push(columns.map((c) => plainField(r[c])).join(" | "))
        }
      }

      const summary =
        `Exported ${totalRows} row${totalRows === 1 ? "" : "s"} to ${pathArg} ` +
        `(${formatBytes(content.length)}, format=${format}).`
      const previewLabel = totalRows > PREVIEW_ROWS
        ? `\nFirst ${PREVIEW_ROWS} rows (full data is in the file):`
        : `\nAll rows:`

      const warn = getQueryWarnings(query)
      const body = `${summary}${previewLabel}\n${previewLines.join("\n")}`
      emitMssqlQualityTrace({
        toolMode: "export",
        phase: "executed",
        query,
        connection: connectionName,
        database: db,
        validation,
        durationMs: Date.now() - startedAt,
        rowCount: totalRows,
      })
      return warn ? `${warn}\n${body}` : body
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitMssqlQualityTrace({
        toolMode: "export",
        phase: "failed",
        query,
        connection: connectionName,
        database: db,
        validation,
        error: msg,
      })
      return `SQL Error: ${decorateMssqlError(msg)}`
    } finally {
      killSignal?.removeEventListener("abort", onKill)
    }
  },
}
