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
import { Buffer } from "node:buffer"
import { readToolTraceContext } from "../../../runtime/loop/tool-execution/trace-context.js"
import type { AgentHost, RunContext } from "../../../runtime/runtime.js"
import type { ExecutableTool, ToolMetadata } from "../../../domain/types/agent-types.js"
import { EXPORT_FORMATS, ExportFormat, isExportFormat } from "../../../domain/enums/tools.js"
import { safePathResolvedWith } from "../../files/filesystem-security.js"
import { getCatalog } from "../../catalog/index.js"
import { getPool } from "./connection.js"
import { resolveToolConnectionArg } from "./resolve-connection.js"
import { decorateMssqlError, enrichInvalidColumnError } from "./error-hints.js"
import { emitMssqlQualityTrace } from "./trace.js"
import { getQueryWarnings, validateQueryDetailed } from "./validation.js"

/** Maximum rows we'll write to a single file. Anything beyond this should be paginated. */
const MAX_EXPORT_ROWS = 1_000_000

/** Number of preview rows returned to the LLM in the tool result. */
const PREVIEW_ROWS = 20

/**
 * Above this size an export is NOT auto-promoted to a downloadable attachment —
 * the bytes are read into memory to promote, and a multi-hundred-MB staging
 * file would risk OOM-ing the server. The file still lands in the sandbox for
 * the agent to read; the agent is told to split the export if the user needs
 * it as a download. Mirrors the run-artifact download cap (64 MiB).
 */
const PROMOTE_MAX_BYTES = 64 * 1024 * 1024

/** MIME per export format — used when promoting the file to an attachment. */
const FORMAT_MEDIA_TYPE: Record<ExportFormat, string> = {
  [ExportFormat.Csv]: "text/csv",
  [ExportFormat.Tsv]: "text/tab-separated-values",
  [ExportFormat.Json]: "json",
  [ExportFormat.Jsonl]: "x-ndjson",
  [ExportFormat.Txt]: "text/plain"
}

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
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function tsvField(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v)
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

/**
 * Outcome of attempting to promote an exported file to a durable attachment.
 * `note` is appended verbatim to the tool result so the agent knows whether
 * the user gets a download link and can say so in its answer.
 */
interface PromotionResult {
  note: string
}

/**
 * Promote an exported sandbox file to a durable, user-downloadable attachment
 * when `deliverable` is true. Guards:
 *   • no attachment store bound (CLI / tests) → silent skip
 *   • file above PROMOTE_MAX_BYTES → skip promote, tell agent to split
 *   • promote throws (quota, IO) → never fail the export; warn instead
 *
 * Returns a short note for the tool result. The file remains in the sandbox
 * either way so the agent can still read it back.
 */
export async function promoteExportedFile(opts: {
  host: AgentHost
  sandboxRelPath: string
  mediaType: string
  deliverable: boolean
  byteSize: number
  purposeTag: string | null
}): Promise<PromotionResult> {
  if (!opts.deliverable) {
    return { note: `\nWorkspace file only (deliverable=false) — not promoted to a download.` }
  }
  const store = opts.host.attachments
  if (!store) {
    // No attachment backend (CLI / tests). The file is still in the sandbox.
    return { note: `\nFile saved to workspace only (no attachment backend in this environment).` }
  }
  if (opts.byteSize > PROMOTE_MAX_BYTES) {
    return {
      note:
        `\nFile is ${formatBytes(opts.byteSize)} — above the ${formatBytes(PROMOTE_MAX_BYTES)} ` +
        `delivery cap, so it was NOT promoted to a download. It remains in the workspace. ` +
        `If the user needs it as a download, split the export into smaller files.`
    }
  }
  try {
    const meta = await store.promoteFromSandbox(opts.sandboxRelPath, {
      mediaType: opts.mediaType,
      ...(opts.purposeTag !== null ? { purposeTag: opts.purposeTag } : {})
    })
    return {
      note:
        `\nSaved as a downloadable file: ${meta.normalizedName} (attachment id=${meta.id}, ` +
        `${formatBytes(meta.sizeBytes)}). The user can download it via the link in chat — ` +
        `mention this in your answer.`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      note:
        `\nFile remains in the workspace; could not promote to a download (${msg}). ` +
        `The user may not be able to retrieve this file.`
    }
  }
}

// ── Schema constants (shared between static export and factory) ───

const EXPORT_QUERY_TO_FILE_DESCRIPTION =
  "Run a SELECT against MSSQL and stream the FULL result set directly to a file. " +
  "Use this whenever the user asks for a complete list/export of many rows " +
  '(e.g. "give me all 4000 dataset names", "export the table", "save the results"). ' +
  "Do NOT use query_mssql + write_file for the same purpose — that forces the model to " +
  "retype every row and almost always truncates the output. " +
  "The tool writes the full dataset to disk and returns only a short summary plus the first " +
  `${PREVIEW_ROWS} rows for you to acknowledge in chat. ` +
  "Format is inferred from the file extension (.csv/.tsv/.json/.jsonl/.txt) or pass format= explicitly. " +
  "For single-column queries, .txt produces a clean newline-separated list; otherwise prefer .csv. " +
  "By default (deliverable=true) the file is ALSO saved as a durable, user-downloadable attachment and " +
  "the user gets a download link in chat — this is what you want whenever the export is meant for the " +
  "user to review/keep. Set deliverable=false ONLY for intermediate staging files you will read back " +
  "yourself (e.g. cross-batch handoff when #temp can't survive) — those stay in the workspace only."

const EXPORT_QUERY_TO_FILE_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "T-SQL SELECT statement. Read-only — INSERT/UPDATE/DELETE etc. are rejected."
    },
    path: {
      type: "string",
      description:
        "Destination file path relative to the workspace root (e.g. 'datasets.csv'). Parent directories are created automatically."
    },
    format: {
      type: "string",
      enum: EXPORT_FORMATS,
      description:
        "Optional explicit format. If omitted, inferred from the path extension. " +
        "csv = comma-separated with header. tsv = tab-separated with header. " +
        "json = single JSON array. jsonl = one JSON object per line. " +
        "txt = one row per line, fields joined with ' | ' (or just the value for single-column queries)."
    },
    deliverable: {
      type: "boolean",
      description:
        "true (default) = also save the file as a durable, user-downloadable attachment and surface a download link in chat. " +
        "Use this whenever the export is for the user to review/keep. " +
        "Set false ONLY for intermediate staging files the agent reads back itself (cross-batch handoff); " +
        "those stay in the workspace only and are NOT promoted."
    },
    purposeTag: {
      type: "string",
      description:
        "Optional short label stored on the promoted attachment (e.g. 'top-5-clients'). Ignored when deliverable=false."
    },
    connection: {
      type: "string",
      description:
        "Named server/pool to connect to (e.g. 'prod', 'uat'). Omit to use the default. Do NOT pass environment names as 'database'."
    },
    database: {
      type: "string",
      description:
        "Optional: switch catalog database on the current server (generates USE [database]). Not for selecting environments."
    }
  },
  required: ["query", "path"]
} as const

async function executeExportQueryToFile(
  args: Record<string, unknown>,
  opts: { resolveSafe: (p: string) => Promise<string>; host: AgentHost; run?: RunContext }
): Promise<string> {
  let query = String(args.query ?? "").trim()
  const pathArg = String(args.path ?? "").trim()
  if (!query) return "Error: query cannot be empty."
  if (!pathArg) return "Error: path cannot be empty."

  let connectionName: string
  try {
    connectionName = resolveToolConnectionArg(opts.host, args)
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
  const toolTrace = readToolTraceContext(args)
  const accessor = () => getCatalog(opts.host, connectionName)

  let pool: sql.ConnectionPool
  try {
    const result = await getPool(opts.host, connectionName)
    pool = result.pool
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }

  // Tool-level read-only: export is SELECT/WITH/#temp only (not a connector latch).
  const validation = validateQueryDetailed(query, {
    readOnly: true,
    accessor,
    profiledTables: opts.run?.mssqlProfileCalls ?? null,
    verifiedTables: opts.run?.mssqlVerifiedTables ?? null
  })
  if (!validation.ok) {
    emitMssqlQualityTrace(
      {
        toolMode: "export",
        phase: "blocked",
        query,
        connection: connectionName,
        database: args.database ? String(args.database).trim() : null,
        validation
      },
      toolTrace
    )
    const lesson = validation.lesson
    if (lesson) {
      try {
        opts.run?.memory?.writeNote?.(lesson)
      } catch (err: unknown) { console.error("[mia]", err) }
    }
    return validation.error ?? "Query blocked"
  }
  query = validation.preparedQuery ?? query

  // Resolve destination path safely under the workspace root.
  let target: string
  try {
    target = await opts.resolveSafe(pathArg)
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
  const killSignal = opts.run?.signal ?? null
  const onKill = (): void => {
    request.cancel()
  }
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
      return (
        `Error: query returned ${totalRows} rows (max ${MAX_EXPORT_ROWS}). ` +
        `Add a WHERE clause or paginate.`
      )
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

    // Auto-promote deliverable exports to a durable, user-downloadable
    // attachment. This is the fix for "the file landed on the server and the
    // user can't get it": promoted files survive hosted sandbox deletion and
    // get a download link in chat. Staging files (deliverable=false) stay in
    // the sandbox only. Best-effort — a promote failure never invalidates the
    // export; the file is still on disk for the agent to read.
    const deliverable = args.deliverable !== false
    const purposeTag =
      typeof args.purposeTag === "string" && args.purposeTag.trim() ? args.purposeTag.trim() : null
    const byteSize = Buffer.byteLength(content, "utf-8")
    const promotion = await promoteExportedFile({
      host: opts.host,
      sandboxRelPath: pathArg,
      mediaType: FORMAT_MEDIA_TYPE[format],
      deliverable,
      byteSize,
      purposeTag
    })

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
    const previewLabel =
      totalRows > PREVIEW_ROWS ? `\nFirst ${PREVIEW_ROWS} rows (full data is in the file):` : `\nAll rows:`

    const warn = getQueryWarnings(query, {
      branchAccessor: accessor as () => {
        getUnionParents(qualifiedName: string): string[]
        getUnionBranches(qualifiedName: string): string[]
      } | null,
      profiledTables: opts.run?.mssqlProfileCalls ?? null
    })
    const body = `${summary}${previewLabel}\n${previewLines.join("\n")}${promotion.note}`
    emitMssqlQualityTrace(
      {
        toolMode: "export",
        phase: "executed",
        query,
        connection: connectionName,
        database: db,
        validation,
        durationMs: Date.now() - startedAt,
        rowCount: totalRows
      },
      toolTrace
    )
    return warn ? `${warn}\n${body}` : body
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitMssqlQualityTrace(
      {
        toolMode: "export",
        phase: "failed",
        query,
        connection: connectionName,
        database: db,
        validation,
        error: msg
      },
      toolTrace
    )
    // Fix #3 (2026-05-23): append catalog-derived column map on `Invalid
    // column name 'X'` so the model gets concrete names instead of guessing.
    const enriched = enrichInvalidColumnError(opts.host, msg, query, connectionName)
    return `SQL Error: ${decorateMssqlError(enriched)}`
  } finally {
    killSignal?.removeEventListener("abort", onKill)
  }
}

/**
 * Static export retained ONLY for schema discovery (name, description,
 * parameters). Calling `.execute()` directly is a misconfiguration — the
 * tool must be built via {@link createExportQueryToFileTool}(host) so it
 * can resolve paths against the per-run workspace root.
 */
export const exportQueryToFileToolMetadata: ToolMetadata = {
  name: "export_query_to_file",
  description: EXPORT_QUERY_TO_FILE_DESCRIPTION,
  parameters: EXPORT_QUERY_TO_FILE_PARAMETERS
}

export const exportQueryToFileTool = exportQueryToFileToolMetadata

/** Factory: build an `export_query_to_file` tool bound to `host.filesystem.basePath`. */
export function createExportQueryToFileTool(host: AgentHost, run?: RunContext): ExecutableTool {
  return {
    ...exportQueryToFileToolMetadata,
    async execute(args) {
      return executeExportQueryToFile(args, {
        resolveSafe: (p) => safePathResolvedWith(host, p),
        host,
        run
      })
    }
  }
}
