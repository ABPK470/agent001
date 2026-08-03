/**
 * Platform schema table types — dialect-agnostic column contracts for Kysely.
 *
 * First cutover table: `connectors`. Add tables here as repos migrate off
 * raw SQLite strings; migrations still own DDL until a migrator ships.
 */

import type { ColumnType, Generated } from "kysely"

/** `connectors` — Bridge / Sync warehouse connector registry. */
export interface ConnectorsTable {
  id: string
  kind: string
  body_json: string
  enabled: number
  created_at: string
  updated_at: string
  updated_by: string | null
}

/**
 * Full platform database shape. Grow table-by-table; unmigrated tables stay
 * on raw better-sqlite3 until their repo moves.
 */
export interface PlatformDatabase {
  connectors: ConnectorsTable
}

/** Helper for optional Generated columns in later tables. */
export type Timestamp = ColumnType<string, string | undefined, string>
export type Gen<T> = Generated<T>
