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

/** `notifications` — in-app notification feed. */
export interface NotificationsTable {
  id: string
  type: string
  title: string
  message: string
  run_id: string | null
  step_id: string | null
  owner_upn: string
  actions: string
  read: number
  created_at: string
}

/** `notification_route_configs` — outbound event → channel routes. */
export interface NotificationRouteConfigsTable {
  id: string
  tenant_id: string
  event_type: string
  filter_json: string
  channel: string
  target: string
  enabled: number
  updated_at: string
  updated_by: string
}

/** `notification_log` — delivery attempts for outbound routes. */
export interface NotificationLogTable {
  id: Generated<number>
  route_id: string | null
  event_type: string
  channel: string
  target: string
  payload_json: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string
  sent_at: string | null
}

/** `api_request_log` — HTTP audit trail. */
export interface ApiRequestLogTable {
  id: Generated<number>
  method: string
  url: string
  status_code: number
  duration_ms: number
  request_body: string | null
  response_summary: string | null
  created_at: string
}

/** `proposer_schedule_configs` — cron schedules per env pair. */
export interface ProposerScheduleConfigsTable {
  tenant_id: string
  source: string
  target: string
  cron: string
  enabled: number
  last_run_at: string | null
  next_run_at: string | null
  updated_at: string
  updated_by: string
}

/** `sync_value_sources` — custom sync value-source definitions. */
export interface SyncValueSourcesTable {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

/** `sync_catalog_versions` — immutable catalog snapshots. */
export interface SyncCatalogVersionsTable {
  tenant_id: string
  version: number
  snapshot_json: string
  reason: string
  created_by: string
  created_at: string
}

/** `sync_catalog_active` — pointer to the live catalog version per tenant. */
export interface SyncCatalogActiveTable {
  tenant_id: string
  version: number
  updated_at: string
}

/** `approval_configs` — risk-tier approval policy per tenant/env. */
export interface ApprovalConfigsTable {
  tenant_id: string
  target_env: string
  risk_tier: string
  policy: string
  approvers_json: string
  bypass_role: string | null
  updated_at: string
  updated_by: string
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
  notifications: NotificationsTable
  notification_route_configs: NotificationRouteConfigsTable
  notification_log: NotificationLogTable
  api_request_log: ApiRequestLogTable
  proposer_schedule_configs: ProposerScheduleConfigsTable
  sync_value_sources: SyncValueSourcesTable
  sync_catalog_versions: SyncCatalogVersionsTable
  sync_catalog_active: SyncCatalogActiveTable
  approval_configs: ApprovalConfigsTable
}

/** Helper for optional Generated columns in later tables. */
export type Timestamp = ColumnType<string, string | undefined, string>
export type Gen<T> = Generated<T>
