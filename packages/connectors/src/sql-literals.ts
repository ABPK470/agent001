/**
 * SQL value literals for Bridge multi-row INSERT statements.
 *
 * Drivers (tedious/mssql) return datetime columns as JS `Date`. `String(date)`
 * yields a locale English dump SQL Server cannot parse — always emit ISO-8601
 * (same convention as @mia/sync `sqlLiteral`).
 */

/** Convert a JS value to a SQL literal for a VALUES clause. */
export function quoteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL"
  }
  if (typeof value === "bigint") return String(value)
  if (typeof value === "boolean") return value ? "1" : "0"
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "NULL"
    // Style 126 / ISO-8601 — culture-invariant for datetime / datetime2 / date.
    return `'${value.toISOString()}'`
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.length === 0 ? "NULL" : `0x${value.toString("hex")}`
  }
  // Tedious DateTimeOffset and similar: duck-typed toISOString.
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toISOString?: unknown }).toISOString === "function"
  ) {
    try {
      const iso = (value as { toISOString: () => string }).toISOString()
      if (typeof iso === "string" && iso.length > 0) return `'${iso}'`
    } catch {
      // fall through to string
    }
  }
  return `N'${String(value).replace(/'/g, "''")}'`
}
