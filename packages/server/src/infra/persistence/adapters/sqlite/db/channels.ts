import { getDb } from "../connection.js"

export interface DbConversationRow {
  id: string
  channel_type: string
  sender_id: string
  sender_name: string | null
  active_run_id: string | null
  thread_id: string | null
  created_at: string
  updated_at: string
}

export interface DbOutboundMessageRow {
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

export interface DbDeliveryAttemptRow {
  id: number
  message_id: string
  attempt_number: number
  status: string
  error: string | null
  duration_ms: number
  created_at: string
}

export interface DbChannelConfigRow {
  type: string
  access_token: string
  verify_token: string
  app_secret: string
  platform_id: string
  created_at: string
  updated_at: string
}

export interface DbDeliveryStatsRow {
  total: number
  delivered: number
  failed: number
  pending: number
}

export function findConversationByChannelAndSender(
  channelType: string,
  senderId: string
): DbConversationRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM conversations WHERE channel_type = ? AND sender_id = ?")
      .get(channelType, senderId) as DbConversationRow | undefined) ?? null
  )
}

export function upsertConversationRow(row: {
  id: string
  channel_type: string
  sender_id: string
  sender_name: string | null
  active_run_id: string | null
  thread_id: string | null
  created_at: string
  updated_at: string
}): void {
  getDb()
    .prepare(
      `
      INSERT OR REPLACE INTO conversations (id, channel_type, sender_id, sender_name, active_run_id, thread_id, created_at, updated_at)
      VALUES (@id, @channel_type, @sender_id, @sender_name, @active_run_id, @thread_id, @created_at, @updated_at)
    `
    )
    .run(row)
}

export function updateConversationThreadId(id: string, threadId: string, updatedAt: string): void {
  getDb()
    .prepare("UPDATE conversations SET thread_id = ?, updated_at = ? WHERE id = ?")
    .run(threadId, updatedAt, id)
}

export function updateConversationActiveRun(id: string, runId: string | null, updatedAt: string): void {
  getDb()
    .prepare("UPDATE conversations SET active_run_id = ?, updated_at = ? WHERE id = ?")
    .run(runId, updatedAt, id)
}

export function getConversationRow(id: string): DbConversationRow | null {
  return (
    (getDb().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as DbConversationRow | undefined) ?? null
  )
}

export function getConversationRowByRunId(runId: string): DbConversationRow | null {
  return (
    (getDb().prepare("SELECT * FROM conversations WHERE active_run_id = ?").get(runId) as
      | DbConversationRow
      | undefined) ?? null
  )
}

export function listConversationRows(): DbConversationRow[] {
  return getDb()
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as DbConversationRow[]
}

export function insertOutboundMessageRow(row: {
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
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO outbound_messages (id, conversation_id, channel_type, recipient_id, text, status, attempts, next_retry_at, last_error, created_at, delivered_at)
      VALUES (@id, @conversation_id, @channel_type, @recipient_id, @text, @status, @attempts, @next_retry_at, @last_error, @created_at, @delivered_at)
    `
    )
    .run(row)
}

export function updateOutboundMessageStatus(input: {
  id: string
  status: string
  error: string | null
  nextRetryAt: string | null
  deliveredAt: string | null
}): void {
  getDb()
    .prepare(
      `
      UPDATE outbound_messages
      SET status = ?, last_error = ?, next_retry_at = ?, delivered_at = ?
      WHERE id = ?
    `
    )
    .run(input.status, input.error, input.nextRetryAt, input.deliveredAt, input.id)
}

export function listPendingOutboundMessageRows(): DbOutboundMessageRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM outbound_messages WHERE status IN ('queued', 'sending', 'retrying') ORDER BY created_at"
    )
    .all() as DbOutboundMessageRow[]
}

export function insertDeliveryAttemptRow(input: {
  messageId: string
  attempt: number
  status: string
  error: string | null
  durationMs: number
  createdAt: string
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO delivery_attempts (message_id, attempt_number, status, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
    .run(input.messageId, input.attempt, input.status, input.error, input.durationMs, input.createdAt)
}

export function updateOutboundMessageAttempts(messageId: string, attempt: number): void {
  getDb().prepare("UPDATE outbound_messages SET attempts = ? WHERE id = ?").run(attempt, messageId)
}

export function upsertChannelConfigRow(row: {
  type: string
  access_token: string
  verify_token: string
  app_secret: string
  platform_id: string
  created_at: string
  updated_at: string
}): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO channel_configs (type, access_token, verify_token, app_secret, platform_id, created_at, updated_at)
    VALUES (@type, @access_token, @verify_token, @app_secret, @platform_id, @created_at, @updated_at)
  `
    )
    .run(row)
}

export function getChannelConfigRow(type: string): DbChannelConfigRow | null {
  return (
    (getDb().prepare("SELECT * FROM channel_configs WHERE type = ?").get(type) as DbChannelConfigRow | undefined) ??
    null
  )
}

export function listChannelConfigRows(): DbChannelConfigRow[] {
  return getDb().prepare("SELECT * FROM channel_configs ORDER BY type").all() as DbChannelConfigRow[]
}

export function deleteChannelConfigRow(type: string): void {
  getDb().prepare("DELETE FROM channel_configs WHERE type = ?").run(type)
}

export function listOutboundMessageRows(conversationId: string, limit: number): DbOutboundMessageRow[] {
  return getDb()
    .prepare("SELECT * FROM outbound_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, limit) as DbOutboundMessageRow[]
}

export function listDeliveryAttemptRows(messageId: string): DbDeliveryAttemptRow[] {
  return getDb()
    .prepare("SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY attempt_number")
    .all(messageId) as DbDeliveryAttemptRow[]
}

export function getDeliveryStatsRows(): { summary: DbDeliveryStatsRow; avgAttemptsOnSuccess: number } {
  const summary = getDb()
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('queued', 'sending', 'retrying') THEN 1 ELSE 0 END) as pending
    FROM outbound_messages
  `
    )
    .get() as DbDeliveryStatsRow

  const avgRow = getDb()
    .prepare(
      `
    SELECT COALESCE(AVG(attempts), 0) as avg_attempts
    FROM outbound_messages WHERE status = 'delivered'
  `
    )
    .get() as { avg_attempts: number }

  return {
    summary,
    avgAttemptsOnSuccess: Math.round(avgRow.avg_attempts * 100) / 100
  }
}
