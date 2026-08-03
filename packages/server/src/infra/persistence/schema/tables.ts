/**
 * Platform schema table types — dialect-agnostic column contracts for Kysely.
 *
 * Grow table-by-table as repos migrate off raw SQLite strings.
 * Migrations still own DDL until a multi-dialect migrator ships.
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

/** `users` — canonical identity. */
export interface UsersTable {
  upn: string
  username: string | null
  display_name: string
  is_admin: number
  password_hash: string | null
  source: string
  created_at: string
  last_login_at: string | null
}

/** `sync_environments` — Sync From/To places. */
export interface SyncEnvironmentsTable {
  name: string
  body_json: string
  created_at: string
  updated_at: string
  updated_by: string | null
}

/**
 * Full platform database shape. Unlisted tables stay on raw better-sqlite3
 * until their repo moves.
 */
export interface PlatformDatabase {
  connectors: ConnectorsTable
  users: UsersTable
  sync_environments: SyncEnvironmentsTable
}

/** Helper for optional Generated columns in later tables. */
export type Timestamp = ColumnType<string, string | undefined, string>
export type Gen<T> = Generated<T>
