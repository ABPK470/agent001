/**
 * Channel persistence — SQLite-backed stores for the message queue and router.
 *
 * Tables:
 *   conversations     — maps (channel, sender) to agent runs
 *   outbound_messages — delivery queue with status tracking
 *   delivery_attempts — audit trail of every send attempt
 *   channel_configs   — registered channel credentials (encrypted at rest TBD)
 */

import {
  deleteChannelConfigRow,
  findConversationByChannelAndSender,
  getChannelConfigRow,
  getConversationRow,
  getConversationRowByRunId,
  getDeliveryStatsRows,
  insertDeliveryAttemptRow,
  insertOutboundMessageRow,
  listChannelConfigRows,
  listConversationRows,
  listDeliveryAttemptRows,
  listOutboundMessageRows,
  listPendingOutboundMessageRows,
  updateConversationActiveRun,
  updateConversationThreadId,
  updateOutboundMessageAttempts,
  updateOutboundMessageStatus,
  upsertChannelConfigRow,
  upsertConversationRow,
  type DbChannelConfigRow,
  type DbConversationRow,
  type DbDeliveryAttemptRow,
  type DbOutboundMessageRow
} from "../../persistence/sqlite.js"
import type { QueueStore } from "./queue.js"
import type { ConversationStore } from "./router.js"
import type { ChannelConfig, ChannelType, Conversation, DeliveryStatus, OutboundMessage } from "./types.js"

export type { DbDeliveryAttemptRow }

// ── Conversation Store ───────────────────────────────────────────

export class SqliteConversationStore implements ConversationStore {
  findByChannelAndSender(channelType: ChannelType, senderId: string): Conversation | undefined {
    const row = findConversationByChannelAndSender(channelType, senderId)
    return row ? toConversation(row) : undefined
  }

  save(conv: Conversation): void {
    upsertConversationRow({
      id: conv.id,
      channel_type: conv.channelType,
      sender_id: conv.senderId,
      sender_name: conv.senderName,
      active_run_id: conv.activeRunId,
      thread_id: conv.threadId,
      created_at: conv.createdAt.toISOString(),
      updated_at: conv.updatedAt.toISOString()
    })
  }

  updateThreadId(id: string, threadId: string): void {
    updateConversationThreadId(id, threadId, new Date().toISOString())
  }

  updateActiveRun(id: string, runId: string | null): void {
    updateConversationActiveRun(id, runId, new Date().toISOString())
  }

  get(id: string): Conversation | undefined {
    const row = getConversationRow(id)
    return row ? toConversation(row) : undefined
  }

  getByRunId(runId: string): Conversation | undefined {
    const row = getConversationRowByRunId(runId)
    return row ? toConversation(row) : undefined
  }

  list(): Conversation[] {
    return listConversationRows().map(toConversation)
  }
}

// ── Queue Store ──────────────────────────────────────────────────

export class SqliteQueueStore implements QueueStore {
  save(msg: OutboundMessage): void {
    insertOutboundMessageRow({
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
      delivered_at: msg.deliveredAt?.toISOString() ?? null
    })
  }

  updateStatus(
    id: string,
    status: DeliveryStatus,
    error: string | null,
    nextRetryAt: Date | null,
    deliveredAt: Date | null
  ): void {
    updateOutboundMessageStatus({
      id,
      status,
      error,
      nextRetryAt: nextRetryAt?.toISOString() ?? null,
      deliveredAt: deliveredAt?.toISOString() ?? null
    })
  }

  loadPending(): OutboundMessage[] {
    return listPendingOutboundMessageRows().map(toOutboundMessage)
  }

  saveAttempt(
    messageId: string,
    attempt: number,
    status: "success" | "failed",
    error: string | null,
    durationMs: number
  ): void {
    insertDeliveryAttemptRow({
      messageId,
      attempt,
      status,
      error,
      durationMs,
      createdAt: new Date().toISOString()
    })
    updateOutboundMessageAttempts(messageId, attempt)
  }
}

// ── Channel Config Store ─────────────────────────────────────────

export function saveChannelConfig(config: ChannelConfig): void {
  const now = new Date().toISOString()
  upsertChannelConfigRow({
    type: config.type,
    access_token: config.accessToken,
    verify_token: config.verifyToken,
    app_secret: config.appSecret,
    platform_id: config.platformId,
    created_at: now,
    updated_at: now
  })
}

export function getChannelConfig(type: ChannelType): ChannelConfig | undefined {
  const row = getChannelConfigRow(type)
  if (!row) return undefined
  return toChannelConfig(row)
}

export function listChannelConfigs(): ChannelConfig[] {
  return listChannelConfigRows().map(toChannelConfig)
}

export function deleteChannelConfig(type: ChannelType): void {
  deleteChannelConfigRow(type)
}

// ── Message queries (for API) ────────────────────────────────────

export function getOutboundMessages(conversationId: string, limit = 50): OutboundMessage[] {
  return listOutboundMessageRows(conversationId, limit).map(toOutboundMessage)
}

export function getDeliveryAttempts(messageId: string): DbDeliveryAttemptRow[] {
  return listDeliveryAttemptRows(messageId)
}

export function getDeliveryStats(): {
  total: number
  delivered: number
  failed: number
  pending: number
  avgAttemptsOnSuccess: number
} {
  const { summary, avgAttemptsOnSuccess } = getDeliveryStatsRows()
  return {
    ...summary,
    avgAttemptsOnSuccess
  }
}

function toConversation(row: DbConversationRow): Conversation {
  return {
    id: row.id,
    channelType: row.channel_type as ChannelType,
    senderId: row.sender_id,
    senderName: row.sender_name,
    activeRunId: row.active_run_id,
    threadId: row.thread_id ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  }
}

function toOutboundMessage(row: DbOutboundMessageRow): OutboundMessage {
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
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null
  }
}

function toChannelConfig(row: DbChannelConfigRow): ChannelConfig {
  return {
    type: row.type as ChannelType,
    accessToken: row.access_token,
    verifyToken: row.verify_token,
    appSecret: row.app_secret,
    platformId: row.platform_id
  }
}
