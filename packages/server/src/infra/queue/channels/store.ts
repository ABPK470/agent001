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
  async findByChannelAndSender(channelType: ChannelType, senderId: string): Promise<Conversation | undefined> {
    const row = await findConversationByChannelAndSender(channelType, senderId)
    return row ? toConversation(row) : undefined
  }

  async save(conv: Conversation): Promise<void> {
    await upsertConversationRow({
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

  async updateThreadId(id: string, threadId: string): Promise<void> {
    await updateConversationThreadId(id, threadId, new Date().toISOString())
  }

  async updateActiveRun(id: string, runId: string | null): Promise<void> {
    await updateConversationActiveRun(id, runId, new Date().toISOString())
  }

  async get(id: string): Promise<Conversation | undefined> {
    const row = await getConversationRow(id)
    return row ? toConversation(row) : undefined
  }

  async getByRunId(runId: string): Promise<Conversation | undefined> {
    const row = await getConversationRowByRunId(runId)
    return row ? toConversation(row) : undefined
  }

  async list(): Promise<Conversation[]> {
    return (await listConversationRows()).map(toConversation)
  }
}

// ── Queue Store ──────────────────────────────────────────────────

export class SqliteQueueStore implements QueueStore {
  async save(msg: OutboundMessage): Promise<void> {
    await insertOutboundMessageRow({
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

  async updateStatus(
    id: string,
    status: DeliveryStatus,
    error: string | null,
    nextRetryAt: Date | null,
    deliveredAt: Date | null
  ): Promise<void> {
    await updateOutboundMessageStatus({
      id,
      status,
      error,
      nextRetryAt: nextRetryAt?.toISOString() ?? null,
      deliveredAt: deliveredAt?.toISOString() ?? null
    })
  }

  async loadPending(): Promise<OutboundMessage[]> {
    return (await listPendingOutboundMessageRows()).map(toOutboundMessage)
  }

  async saveAttempt(
    messageId: string,
    attempt: number,
    status: "success" | "failed",
    error: string | null,
    durationMs: number
  ): Promise<void> {
    await insertDeliveryAttemptRow({
      messageId,
      attempt,
      status,
      error,
      durationMs,
      createdAt: new Date().toISOString()
    })
    await updateOutboundMessageAttempts(messageId, attempt)
  }
}

// ── Channel Config Store ─────────────────────────────────────────

export async function saveChannelConfig(config: ChannelConfig): Promise<void> {
  const now = new Date().toISOString()
  await upsertChannelConfigRow({
    type: config.type,
    access_token: config.accessToken,
    verify_token: config.verifyToken,
    app_secret: config.appSecret,
    platform_id: config.platformId,
    created_at: now,
    updated_at: now
  })
}

export async function getChannelConfig(type: ChannelType): Promise<ChannelConfig | undefined> {
  const row = await getChannelConfigRow(type)
  if (!row) return undefined
  return toChannelConfig(row)
}

export async function listChannelConfigs(): Promise<ChannelConfig[]> {
  return (await listChannelConfigRows()).map(toChannelConfig)
}

export async function deleteChannelConfig(type: ChannelType): Promise<void> {
  await deleteChannelConfigRow(type)
}

// ── Message queries (for API) ────────────────────────────────────

export async function getOutboundMessages(conversationId: string, limit = 50): Promise<OutboundMessage[]> {
  return (await listOutboundMessageRows(conversationId, limit)).map(toOutboundMessage)
}

export async function getDeliveryAttempts(messageId: string): Promise<DbDeliveryAttemptRow[]> {
  return await listDeliveryAttemptRows(messageId)
}

export async function getDeliveryStats(): Promise<{
  total: number
  delivered: number
  failed: number
  pending: number
  avgAttemptsOnSuccess: number
}> {
  const { summary, avgAttemptsOnSuccess } = await getDeliveryStatsRows()
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
