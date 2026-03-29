/**
 * Channel persistence — SQLite-backed stores for the message queue and router.
 *
 * Tables:
 *   conversations     — maps (channel, sender) to agent runs
 *   outbound_messages — delivery queue with status tracking
 *   delivery_attempts — audit trail of every send attempt
 *   channel_configs   — registered channel credentials (encrypted at rest TBD)
 */

import type { QueueStore } from "./queue.js"
import type { ConversationStore } from "./router.js"
import type { ChannelConfig, ChannelType, Conversation, DeliveryStatus, OutboundMessage } from "./types.js"
import { getDb } from "../db.js"

// ── Migration ────────────────────────────────────────────────────

export function migrateChannels(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      active_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel_type, sender_id)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_channel_sender
      ON conversations(channel_type, sender_id);

    CREATE INDEX IF NOT EXISTS idx_conv_run
      ON conversations(active_run_id);

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_outbound_status
      ON outbound_messages(status);

    CREATE INDEX IF NOT EXISTS idx_outbound_conv
      ON outbound_messages(conversation_id);

    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES outbound_messages(id)
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_msg
      ON delivery_attempts(message_id);

    CREATE TABLE IF NOT EXISTS channel_configs (
      type TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      verify_token TEXT NOT NULL,
      app_secret TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

// ── Conversation Store ───────────────────────────────────────────

export class SqliteConversationStore implements ConversationStore {
  findByChannelAndSender(channelType: ChannelType, senderId: string): Conversation | undefined {
    const row = getDb()
      .prepare("SELECT * FROM conversations WHERE channel_type = ? AND sender_id = ?")
      .get(channelType, senderId) as DbConversation | undefined

    return row ? toConversation(row) : undefined
  }

  save(conv: Conversation): void {
    getDb().prepare(`
      INSERT OR REPLACE INTO conversations (id, channel_type, sender_id, sender_name, active_run_id, created_at, updated_at)
      VALUES (@id, @channel_type, @sender_id, @sender_name, @active_run_id, @created_at, @updated_at)
    `).run({
      id: conv.id,
      channel_type: conv.channelType,
      sender_id: conv.senderId,
      sender_name: conv.senderName,
      active_run_id: conv.activeRunId,
      created_at: conv.createdAt.toISOString(),
      updated_at: conv.updatedAt.toISOString(),
    })
  }

  updateActiveRun(id: string, runId: string | null): void {
    getDb()
      .prepare("UPDATE conversations SET active_run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, new Date().toISOString(), id)
  }

  get(id: string): Conversation | undefined {
    const row = getDb()
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as DbConversation | undefined

    return row ? toConversation(row) : undefined
  }

  getByRunId(runId: string): Conversation | undefined {
    const row = getDb()
      .prepare("SELECT * FROM conversations WHERE active_run_id = ?")
      .get(runId) as DbConversation | undefined

    return row ? toConversation(row) : undefined
  }

  list(): Conversation[] {
    const rows = getDb()
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
      .all() as DbConversation[]

    return rows.map(toConversation)
  }
}

// ── Queue Store ──────────────────────────────────────────────────

export class SqliteQueueStore implements QueueStore {
  save(msg: OutboundMessage): void {
    getDb().prepare(`
      INSERT INTO outbound_messages (id, conversation_id, channel_type, recipient_id, text, status, attempts, next_retry_at, last_error, created_at, delivered_at)
      VALUES (@id, @conversation_id, @channel_type, @recipient_id, @text, @status, @attempts, @next_retry_at, @last_error, @created_at, @delivered_at)
    `).run({
      id: msg.id,
      conversation_id: msg.conversationId,
      channel_type: msg.channelType,
      recipient_id: msg.recipientId,
      text: msg.text,
      status: msg.status,
      attempts: msg.attempts,
      next_retry_at: msg.nextRetryAt?.toISOString() ?? null,
      last_error: msg.lastError,
      created_at: msg.createdAt.toISOString(),
      delivered_at: msg.deliveredAt?.toISOString() ?? null,
    })
  }

  updateStatus(
    id: string,
    status: DeliveryStatus,
    error: string | null,
    nextRetryAt: Date | null,
    deliveredAt: Date | null,
  ): void {
    getDb().prepare(`
      UPDATE outbound_messages
      SET status = ?, last_error = ?, next_retry_at = ?, delivered_at = ?
      WHERE id = ?
    `).run(status, error, nextRetryAt?.toISOString() ?? null, deliveredAt?.toISOString() ?? null, id)
  }

  loadPending(): OutboundMessage[] {
    const rows = getDb()
      .prepare("SELECT * FROM outbound_messages WHERE status IN ('queued', 'sending', 'retrying') ORDER BY created_at")
      .all() as DbOutboundMessage[]

    return rows.map(toOutboundMessage)
  }

  saveAttempt(
    messageId: string,
    attempt: number,
    status: "success" | "failed",
    error: string | null,
    durationMs: number,
  ): void {
    getDb().prepare(`
      INSERT INTO delivery_attempts (message_id, attempt_number, status, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(messageId, attempt, status, error, durationMs, new Date().toISOString())

    // Update attempt count on the message
    getDb()
      .prepare("UPDATE outbound_messages SET attempts = ? WHERE id = ?")
      .run(attempt, messageId)
  }
}

// ── Channel Config Store ─────────────────────────────────────────

export function saveChannelConfig(config: ChannelConfig): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO channel_configs (type, access_token, verify_token, app_secret, platform_id, created_at, updated_at)
    VALUES (@type, @access_token, @verify_token, @app_secret, @platform_id, @created_at, @updated_at)
  `).run({
    type: config.type,
    access_token: config.accessToken,
    verify_token: config.verifyToken,
    app_secret: config.appSecret,
    platform_id: config.platformId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
}

export function getChannelConfig(type: ChannelType): ChannelConfig | undefined {
  const row = getDb()
    .prepare("SELECT * FROM channel_configs WHERE type = ?")
    .get(type) as DbChannelConfig | undefined

  if (!row) return undefined
  return {
    type: row.type as ChannelType,
    accessToken: row.access_token,
    verifyToken: row.verify_token,
    appSecret: row.app_secret,
    platformId: row.platform_id,
  }
}

export function listChannelConfigs(): ChannelConfig[] {
  const rows = getDb()
    .prepare("SELECT * FROM channel_configs ORDER BY type")
    .all() as DbChannelConfig[]

  return rows.map((row) => ({
    type: row.type as ChannelType,
    accessToken: row.access_token,
    verifyToken: row.verify_token,
    appSecret: row.app_secret,
    platformId: row.platform_id,
  }))
}

export function deleteChannelConfig(type: ChannelType): void {
  getDb().prepare("DELETE FROM channel_configs WHERE type = ?").run(type)
}

// ── Message queries (for API) ────────────────────────────────────

export function getOutboundMessages(conversationId: string, limit = 50): OutboundMessage[] {
  const rows = getDb()
    .prepare("SELECT * FROM outbound_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(conversationId, limit) as DbOutboundMessage[]

  return rows.map(toOutboundMessage)
}

export function getDeliveryAttempts(messageId: string): DbDeliveryAttempt[] {
  return getDb()
    .prepare("SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY attempt_number")
    .all(messageId) as DbDeliveryAttempt[]
}

export function getDeliveryStats(): {
  total: number
  delivered: number
  failed: number
  pending: number
  avgAttemptsOnSuccess: number
} {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('queued', 'sending', 'retrying') THEN 1 ELSE 0 END) as pending
    FROM outbound_messages
  `).get() as { total: number; delivered: number; failed: number; pending: number }

  const avgRow = getDb().prepare(`
    SELECT COALESCE(AVG(attempts), 0) as avg_attempts
    FROM outbound_messages WHERE status = 'delivered'
  `).get() as { avg_attempts: number }

  return {
    ...row,
    avgAttemptsOnSuccess: Math.round(avgRow.avg_attempts * 100) / 100,
  }
}

// ── DB row types & mappers ───────────────────────────────────────

interface DbConversation {
  id: string
  channel_type: string
  sender_id: string
  sender_name: string | null
  active_run_id: string | null
  created_at: string
  updated_at: string
}

function toConversation(row: DbConversation): Conversation {
  return {
    id: row.id,
    channelType: row.channel_type as ChannelType,
    senderId: row.sender_id,
    senderName: row.sender_name,
    activeRunId: row.active_run_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

interface DbOutboundMessage {
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

function toOutboundMessage(row: DbOutboundMessage): OutboundMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channelType: row.channel_type as ChannelType,
    recipientId: row.recipient_id,
    text: row.text,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
  }
}

export interface DbDeliveryAttempt {
  id: number
  message_id: string
  attempt_number: number
  status: string
  error: string | null
  duration_ms: number
  created_at: string
}

interface DbChannelConfig {
  type: string
  access_token: string
  verify_token: string
  app_secret: string
  platform_id: string
  created_at: string
  updated_at: string
}
