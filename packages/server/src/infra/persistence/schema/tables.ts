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

/** `sessions` — opaque transport tokens FK'd to users. */
export interface SessionsTable {
  sid: string
  upn: string
  ip: string | null
  user_agent: string | null
  created_at: string
  last_seen_at: string
}

/** `llm_config` — singleton row (`id = 1`) for agent model settings. */
export interface LlmConfigTable {
  id: number
  provider: string
  model: string
  api_key: string
  base_url: string
  updated_at: string
}

/** `freeze_window_configs` — tenant-scoped change freezes. */
export interface FreezeWindowConfigsTable {
  tenant_id: string
  id: string
  display_name: string
  description: string
  starts_at: string
  ends_at: string
  created_by: string
  created_at: string
  updated_at: string
}

/**
 * Full platform database shape. Unlisted tables stay on raw better-sqlite3
 * until their repo moves.
 */
export interface PlatformDatabase {
  connectors: ConnectorsTable
  users: UsersTable
  sync_environments: SyncEnvironmentsTable
  sessions: SessionsTable
  llm_config: LlmConfigTable
  freeze_window_configs: FreezeWindowConfigsTable
}

/** Helper for optional Generated columns in later tables. */
export type Timestamp = ColumnType<string, string | undefined, string>
export type Gen<T> = Generated<T>
