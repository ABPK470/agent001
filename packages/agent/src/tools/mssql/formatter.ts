import sql from "mssql"

// ── Row formatting ───────────────────────────────────────────────

/**
 * INSPECTION cap — query_mssql is for analysis/sampling, not bulk export.
 * Above this row count we render a small preview only and direct the model
 * to export_query_to_file for the full set. This is intentionally low so the
 * model has nothing useful to copy-paste into write_file.
 */
const MAX_ROWS = 200
/** Hard byte cap on the rendered output (after MAX_ROWS preview cap). */
const MAX_RESULT_LENGTH = 50_000
/** When the byte cap would trigger, fall back to this many preview rows. */
const FALLBACK_PREVIEW_ROWS = 30

function formatRowValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

function renderTable(columns: string[], rows: unknown[]): string[] {
  const out: string[] = []
  out.push(columns.join(" | "))
  out.push(columns.map((c) => "-".repeat(Math.min(c.length, 20))).join("-+-"))
  for (const row of rows) {
    const r = row as Record<string, unknown>
    out.push(columns.map((c) => formatRowValue(r[c])).join(" | "))
  }
  return out
}

const EXPORT_HINT =
  "If the user asked you to SAVE/EXPORT these rows to a file, do NOT copy this text into " +
  "write_file/replace_in_file/append_file — it is a PREVIEW, not the full result, and the file would " +
  "be broken/partial. Call export_query_to_file(query='<your SELECT — list ONLY the columns you need, " +
  "never SELECT *>', path='<file>') instead — it streams every row directly to disk."

export function formatResults(recordsets: sql.IRecordSet<unknown>[], rowsAffected: number[]): string {
  if (recordsets.length === 0) {
    return `Query executed. Rows affected: ${rowsAffected.join(", ")}`
  }

  const parts: string[] = []

  for (let i = 0; i < recordsets.length; i++) {
    const rs = recordsets[i]
    if (!rs || rs.length === 0) {
      parts.push(i > 0 ? `\n--- Result set ${i + 1}: (empty) ---` : "(empty result set)")
      continue
    }

    const columns = Object.keys(rs[0] as Record<string, unknown>)
    const totalRows = rs.length
    const previewLimit = MAX_ROWS
    const rows = rs.slice(0, previewLimit)
    const truncated = totalRows > previewLimit

    if (recordsets.length > 1) {
      parts.push(`\n--- Result set ${i + 1} (${totalRows} rows) ---`)
    } else {
      parts.push(`(${totalRows} row${totalRows !== 1 ? "s" : ""})`)
    }

    // ── Scalar special case: 1 row × 1 column ──
    // The default tabular layout (header, dashed separator, value-on-its-own-line)
    // has caused models to drop trailing digits when summarising the answer.
    // Render scalars as `column = value` instead — unambiguous, single line.
    if (totalRows === 1 && columns.length === 1) {
      const r = rs[0] as Record<string, unknown>
      parts.push(`${columns[0]} = ${formatRowValue(r[columns[0]])}`)
      continue
    }

    parts.push(...renderTable(columns, rows))

    if (truncated) {
      parts.push(`... (${totalRows - previewLimit} more rows omitted — preview is capped at ${previewLimit})`)
      parts.push(
        `\n⚠️ ROW LIMIT WARNING: this is a PREVIEW of the first ${previewLimit} of ${totalRows} rows. ` +
        EXPORT_HINT
      )
    }
  }

  let result = parts.join("\n")

  // Hard byte cap fallback — if even the preview is too large (very wide
  // columns, JSON blobs, etc.), shrink to a tiny sample so the model has
  // nothing pastable. We re-render with a small row count rather than slicing
  // mid-row, which previously left dangling partial values like "Financi...".
  if (result.length > MAX_RESULT_LENGTH) {
    const fallbackParts: string[] = []
    for (let i = 0; i < recordsets.length; i++) {
      const rs = recordsets[i]
      if (!rs || rs.length === 0) continue
      const columns = Object.keys(rs[0] as Record<string, unknown>)
      const sample = rs.slice(0, FALLBACK_PREVIEW_ROWS)
      const totalRows = rs.length
      if (recordsets.length > 1) {
        fallbackParts.push(`\n--- Result set ${i + 1} (${totalRows} rows; preview shrunk to ${sample.length}) ---`)
      } else {
        fallbackParts.push(`(${totalRows} rows; preview shrunk to ${sample.length} due to byte cap)`)
      }
      fallbackParts.push(...renderTable(columns, sample))
      fallbackParts.push(
        `... (${totalRows - sample.length} more rows omitted; rendered preview exceeded ${MAX_RESULT_LENGTH} bytes)`
      )
    }
    fallbackParts.push(
      `\n⚠️ TRUNCATION WARNING: the full preview exceeded ${MAX_RESULT_LENGTH} bytes (likely wide columns or JSON/blob fields). ` +
      EXPORT_HINT +
      ` Also: SELECT only the columns you need — never SELECT * on tables with JSON/blob columns (e.g. core.Dataset.controlFlow is ~50KB per row).`
    )
    result = fallbackParts.join("\n")
  }
  return result
}
