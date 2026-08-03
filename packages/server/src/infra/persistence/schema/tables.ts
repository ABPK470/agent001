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

/** `sync_approvals` — proposal approval state machine. */
export interface SyncApprovalsTable {
  id: string
  proposal_id: string
  tenant_id: string
  requested_by: string
  requested_at: string
  expires_at: string
  policy: string
  state: string
  granted_by_1: string | null
  granted_at_1: string | null
  granted_by_2: string | null
  granted_at_2: string | null
  rejected_by: string | null
  rejected_at: string | null
  reject_reason: string | null
  bypass_by: string | null
  bypass_reason: string | null
  plan_id_at_request: string | null
  plan_hash_at_request: string | null
}

/** `sync_approval_tokens` — one-click HMAC grant/reject tokens. */
export interface SyncApprovalTokensTable {
  token_hash: string
  approval_id: string
  action: string
  issued_to: string
  issued_at: string
  expires_at: string
  used_at: string | null
  used_by: string | null
}

/** `conversations` — channel inbox threads. */
export interface ConversationsTable {
  id: string
  channel_type: string
  sender_id: string
  sender_name: string | null
  active_run_id: string | null
  thread_id: string | null
  created_at: string
  updated_at: string
}

/** `outbound_messages` — channel delivery queue. */
export interface OutboundMessagesTable {
  id: string
  conversation_id: string
  channel_type: string
  recipient_id: string
  text: string
  status: string
  attempts: number
  next_retry_at: string | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
}

/** `delivery_attempts` — per-send attempt log. */
export interface DeliveryAttemptsTable {
  id: Generated<number>
  message_id: string
  attempt_number: number
  status: string
  error: string | null
  duration_ms: number
  created_at: string
}

/** `channel_configs` — Teams (etc.) connector secrets. */
export interface ChannelConfigsTable {
  type: string
  access_token: string
  verify_token: string
  app_secret: string
  platform_id: string
  created_at: string
  updated_at: string
}

/** `effects` — run side-effect journal. */
export interface EffectsTable {
  id: string
  run_id: string
  seq: number
  kind: string
  tool: string
  target: string
  pre_hash: string | null
  post_hash: string | null
  status: string
  metadata: string
  created_at: string
}

/** `file_snapshots` — pre/post file content for effects. */
export interface FileSnapshotsTable {
  id: string
  effect_id: string
  run_id: string
  file_path: string
  content: string | null
  hash: string | null
  file_mode: number | null
  created_at: string
}

/** `threads` — named conversation workspaces. */
export interface ThreadsTable {
  id: string
  upn: string
  title: string
  created_at: string
  updated_at: string
  archived_at: string | null
  pinned: number
}

/**
 * `runs` — agent run records.
 * Full column contract so other repos can migrate onto the same type.
 */
export interface RunsTable {
  id: string
  goal: string
  status: string
  answer: string | null
  step_count: number
  error: string | null
  parent_run_id: string | null
  agent_id: string | null
  thread_id: string | null
  upn: string
  display_name: string
  created_at: string
  completed_at: string | null
}

/** `token_usage` — per-run LLM usage rollup. */
export interface TokenUsageTable {
  run_id: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  llm_calls: number
  model: string
  created_at: string
}

/** `checkpoints` — resumable agent loop state. */
export interface CheckpointsTable {
  run_id: string
  messages: string
  iteration: number
  step_counter: number
  updated_at: string
}

/** `run_log` — structured per-run log lines. */
export interface RunLogTable {
  id: Generated<number>
  run_id: string
  level: string
  message: string
  timestamp: string
}

/** `trace_entries` — ordered trace events for a run. */
export interface TraceEntriesTable {
  id: Generated<number>
  run_id: string
  seq: number
  data: string
  created_at: string
}

/** `audit_log` — run/admin action audit. */
export interface AuditLogTable {
  id: Generated<number>
  run_id: string | null
  scope_type: string
  scope_id: string | null
  actor: string
  action: string
  detail: string
  timestamp: string
}

/** `webhook_drain_configs` — outbound event webhooks. */
export interface WebhookDrainConfigsTable {
  id: string
  url: string
  secret: string
  event_filters: string
  enabled: number
  created_at: string
  updated_at: string
}

/** `agent_messages` — inter-agent bus durability. */
export interface AgentMessagesTable {
  id: string
  root_run_id: string
  from_run_id: string
  from_agent: string
  protocol: string
  topic: string
  content: string
  reply_to: string | null
  created_at: string
}

/** `proposer_runs` — one proposer pass envelope. */
export interface ProposerRunsTable {
  id: string
  tenant_id: string
  source: string
  target: string
  started_at: string
  finished_at: string | null
  status: string
  scanned: number
  produced: number
  errors: number
  duration_ms: number | null
  triggered_by: string
  trigger: string
  error: string | null
}

/** `sync_proposals` — proposer findings awaiting review. */
export interface SyncProposalsTable {
  id: string
  tenant_id: string
  run_id: string
  fingerprint: string
  source: string
  target: string
  entity_type: string
  entity_id: string
  entity_label: string
  kind: string
  counts_json: string
  detail_json: string
  entity_def_version: number | null
  observed_at: string
  enqueued_at: string
  status: string
  annotation_json: string | null
  annotation_failed_open: number
  risk_tier: string | null
  risk_score: number | null
  rank_score: number | null
  plan_id: string | null
  snooze_until: string | null
  superseded_by: string | null
  last_actor: string | null
  last_action: string | null
  last_action_at: string | null
}

/** `sync_proposal_history` — append-only proposal transitions. */
export interface SyncProposalHistoryTable {
  id: Generated<number>
  proposal_id: string
  from_status: string | null
  to_status: string
  actor: string
  reason: string
  detail_json: string
  at: string
}

/** `sync_publish_meta` — published catalog stamp per tenant. */
export interface SyncPublishMetaTable {
  tenant_id: string
  published_at: string
  published_version: string
  catalog_version: number | null
}

/** `sync_definitions` — live published SyncDefinition JSON per entity. */
export interface SyncDefinitionsTable {
  tenant_id: string
  entity_id: string
  definition_json: string
  published_at: string | null
  published_version: string | null
}

/** `run_tool_approvals` — RequireApproval grants for agent runs. */
export interface RunToolApprovalsTable {
  id: string
  run_id: string
  step_id: string
  tool_name: string
  args_json: string
  reason: string
  policy_name: string
  status: string
  requested_at: string
  resolved_at: string | null
  resolved_by: string | null
}

/** `sync_tool_approvals` — RequireApproval grants for Env Sync tools. */
export interface SyncToolApprovalsTable {
  id: string
  actor_upn: string
  tool_name: string
  args_json: string
  args_key: string
  reason: string
  policy_name: string
  status: string
  requested_at: string
  resolved_at: string | null
  resolved_by: string | null
}

/** `tool_results` — structured tool-call payloads for prior-turn grounding. */
export interface ToolResultsTable {
  id: Generated<number>
  run_id: string
  tool_call_id: string
  tool_name: string
  args_json: string
  result_json: string
  row_count: number | null
  bytes: number
  truncated: number
  goal_excerpt: string | null
  created_at: string
}

/** `sync_sql_log` — full-text SQL trace for sync operations. */
export interface SyncSqlLogTable {
  id: Generated<number>
  plan_id: string | null
  preview_id: string | null
  event_type: string
  scope: string | null
  label: string
  connection: string
  sql_text: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  created_at: string
}

/** `entity_active` — current-version cursor for entity definitions. */
export interface EntityActiveTable {
  tenant_id: string
  id: string
  current_version: number
  retired_at: string | null
}

/** `entity_versions` — immutable entity definition history. */
export interface EntityVersionsTable {
  tenant_id: string
  id: string
  version: number
  body_json: string
  version_label: string | null
  created_by: string
  created_at: string
  reason: string
  diff_json: string
}

/** `scd2_strategy_active` — current-version cursor for SCD2 strategies. */
export interface Scd2StrategyActiveTable {
  tenant_id: string
  id: string
  current_version: number
  retired_at: string | null
}

/** `scd2_strategy_versions` — immutable SCD2 strategy history. */
export interface Scd2StrategyVersionsTable {
  tenant_id: string
  id: string
  version: number
  body_json: string
  created_by: string
  created_at: string
  reason: string
}

/** `sync_runs` — one row per executeSync invocation. */
export interface SyncRunsTable {
  plan_id: string
  entity_type: string
  entity_id: string
  entity_display_name: string | null
  source: string
  target: string
  actor_upn: string
  preview_inserts: number
  preview_updates: number
  preview_deletes: number
  executed_inserts: number | null
  executed_updates: number | null
  executed_deletes: number | null
  preview_totals_json: string
  execute_totals_json: string | null
  plan_json: string | null
  status: string
  error: string | null
  drift_detected_pct: number | null
  started_at: string
  finished_at: string | null
  duration_ms: number | null
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
  sync_approvals: SyncApprovalsTable
  sync_approval_tokens: SyncApprovalTokensTable
  conversations: ConversationsTable
  outbound_messages: OutboundMessagesTable
  delivery_attempts: DeliveryAttemptsTable
  channel_configs: ChannelConfigsTable
  effects: EffectsTable
  file_snapshots: FileSnapshotsTable
  threads: ThreadsTable
  runs: RunsTable
  token_usage: TokenUsageTable
  checkpoints: CheckpointsTable
  run_log: RunLogTable
  trace_entries: TraceEntriesTable
  audit_log: AuditLogTable
  webhook_drain_configs: WebhookDrainConfigsTable
  agent_messages: AgentMessagesTable
  proposer_runs: ProposerRunsTable
  sync_proposals: SyncProposalsTable
  sync_proposal_history: SyncProposalHistoryTable
  sync_publish_meta: SyncPublishMetaTable
  sync_definitions: SyncDefinitionsTable
  run_tool_approvals: RunToolApprovalsTable
  sync_tool_approvals: SyncToolApprovalsTable
  tool_results: ToolResultsTable
  sync_sql_log: SyncSqlLogTable
  sync_runs: SyncRunsTable
  entity_active: EntityActiveTable
  entity_versions: EntityVersionsTable
  scd2_strategy_active: Scd2StrategyActiveTable
  scd2_strategy_versions: Scd2StrategyVersionsTable
}

/** Helper for optional Generated columns in later tables. */
export type Timestamp = ColumnType<string, string | undefined, string>
export type Gen<T> = Generated<T>
