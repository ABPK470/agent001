/**
 * Dialect-aware SQL identifier quoting for Bridge writes.
 *
 * Catalog / SearchablePick emit `schema.table`. Quoting the whole string as one
 * identifier (`"dbo.Foo"`) is invalid — each segment must be quoted separately.
 */

/** Bracket-quote one MSSQL identifier part. */
export function quoteMssqlIdent(part: string): string {
  return `[${part.replace(/]/g, "]]")}]`
}

/** `dbo.Foo` → `[dbo].[Foo]` (matches list-tables / live picker names). */
export function quoteMssqlTable(name: string): string {
  return name.split(".").map(quoteMssqlIdent).join(".")
}

/** Double-quote one Postgres / Databricks identifier part. */
export function quotePgIdent(part: string): string {
  return `"${part.replace(/"/g, '""')}"`
}

/** `public.foo` → `"public"."foo"`. */
export function quotePgTable(name: string): string {
  return name.split(".").map(quotePgIdent).join(".")
}

/** Oracle uses the same double-quote rules as Postgres for delimited identifiers. */
export const quoteOracleIdent = quotePgIdent

/** `HR.EMPLOYEES` → `"HR"."EMPLOYEES"`. */
export const quoteOracleTable = quotePgTable

/** Split `OWNER.TABLE` (or bare `TABLE`) for Oracle data-dictionary lookups. */
export function splitOracleTable(name: string): { owner: string | null; table: string } {
  const parts = name.split(".").filter((p) => p.length > 0)
  if (parts.length >= 2) {
    return { owner: parts[0]!.toUpperCase(), table: parts[parts.length - 1]!.toUpperCase() }
  }
  return { owner: null, table: (parts[0] ?? name).toUpperCase() }
}
