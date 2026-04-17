import sql from "mssql"

// ── Row formatting ───────────────────────────────────────────────

const MAX_ROWS = 1000
const MAX_RESULT_LENGTH = 50_000

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
    const rows = rs.slice(0, MAX_ROWS)
    const truncated = rs.length > MAX_ROWS

    if (recordsets.length > 1) {
      parts.push(`\n--- Result set ${i + 1} (${rs.length} rows) ---`)
    } else {
      parts.push(`(${rs.length} row${rs.length !== 1 ? "s" : ""})`)
    }

    // Column headers
    parts.push(columns.join(" | "))
    parts.push(columns.map((c) => "-".repeat(Math.min(c.length, 20))).join("-+-"))

    // Data rows
    for (const row of rows) {
      const r = row as Record<string, unknown>
      const vals = columns.map((c) => {
        const v = r[c]
        if (v === null || v === undefined) return "NULL"
        if (v instanceof Date) return v.toISOString()
        if (typeof v === "object") return JSON.stringify(v)
        return String(v)
      })
      parts.push(vals.join(" | "))
    }

    if (truncated) {
      parts.push(`... (${rs.length - MAX_ROWS} more rows truncated, showing first ${MAX_ROWS})`)
    }
  }

  let result = parts.join("\n")
  if (result.length > MAX_RESULT_LENGTH) {
    result = result.slice(0, MAX_RESULT_LENGTH) + "\n... (output truncated)"
  }
  return result
}
