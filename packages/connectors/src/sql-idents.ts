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
