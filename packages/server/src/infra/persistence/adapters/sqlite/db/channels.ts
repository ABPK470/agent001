import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("channel_type", "=", channelType)
    .where("sender_id", "=", senderId)
    .compile()
  return runGet<DbConversationRow>(compiled) ?? null
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
  const compiled = getPlatformDb()
    .insertInto("conversations")
    .orReplace()
    .values(row)
    .compile()
  runExec(compiled)
}

export function updateConversationThreadId(id: string, threadId: string, updatedAt: string): void {
  const compiled = getPlatformDb()
    .updateTable("conversations")
    .set({ thread_id: threadId, updated_at: updatedAt })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function updateConversationActiveRun(id: string, runId: string | null, updatedAt: string): void {
  const compiled = getPlatformDb()
    .updateTable("conversations")
    .set({ active_run_id: runId, updated_at: updatedAt })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function getConversationRow(id: string): DbConversationRow | null {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbConversationRow>(compiled) ?? null
}

export function getConversationRowByRunId(runId: string): DbConversationRow | null {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("active_run_id", "=", runId)
    .compile()
  return runGet<DbConversationRow>(compiled) ?? null
}

export function listConversationRows(): DbConversationRow[] {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .orderBy("updated_at", "desc")
    .compile()
  return runAll<DbConversationRow>(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("outbound_messages")
    .values(row)
    .compile()
  runExec(compiled)
}

export function updateOutboundMessageStatus(input: {
  id: string
  status: string
  error: string | null
  nextRetryAt: string | null
  deliveredAt: string | null
}): void {
  const compiled = getPlatformDb()
    .updateTable("outbound_messages")
    .set({
      status: input.status,
      last_error: input.error,
      next_retry_at: input.nextRetryAt,
      delivered_at: input.deliveredAt,
    })
    .where("id", "=", input.id)
    .compile()
  runExec(compiled)
}

export function listPendingOutboundMessageRows(): DbOutboundMessageRow[] {
  const compiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .selectAll()
    .where("status", "in", ["queued", "sending", "retrying"])
    .orderBy("created_at")
    .compile()
  return runAll<DbOutboundMessageRow>(compiled)
}

export function insertDeliveryAttemptRow(input: {
  messageId: string
  attempt: number
  status: string
  error: string | null
  durationMs: number
  createdAt: string
}): void {
  const compiled = getPlatformDb()
    .insertInto("delivery_attempts")
    .values({
      message_id: input.messageId,
      attempt_number: input.attempt,
      status: input.status,
      error: input.error,
      duration_ms: input.durationMs,
      created_at: input.createdAt,
    })
    .compile()
  runExec(compiled)
}

export function updateOutboundMessageAttempts(messageId: string, attempt: number): void {
  const compiled = getPlatformDb()
    .updateTable("outbound_messages")
    .set({ attempts: attempt })
    .where("id", "=", messageId)
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("channel_configs")
    .orReplace()
    .values(row)
    .compile()
  runExec(compiled)
}

export function getChannelConfigRow(type: string): DbChannelConfigRow | null {
  const compiled = getPlatformDb()
    .selectFrom("channel_configs")
    .selectAll()
    .where("type", "=", type)
    .compile()
  return runGet<DbChannelConfigRow>(compiled) ?? null
}

export function listChannelConfigRows(): DbChannelConfigRow[] {
  const compiled = getPlatformDb()
    .selectFrom("channel_configs")
    .selectAll()
    .orderBy("type")
    .compile()
  return runAll<DbChannelConfigRow>(compiled)
}

export function deleteChannelConfigRow(type: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("channel_configs")
    .where("type", "=", type)
    .compile()
  runExec(compiled)
}

export function listOutboundMessageRows(conversationId: string, limit: number): DbOutboundMessageRow[] {
  const compiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return runAll<DbOutboundMessageRow>(compiled)
}

export function listDeliveryAttemptRows(messageId: string): DbDeliveryAttemptRow[] {
  const compiled = getPlatformDb()
    .selectFrom("delivery_attempts")
    .selectAll()
    .where("message_id", "=", messageId)
    .orderBy("attempt_number")
    .compile()
  return runAll<DbDeliveryAttemptRow>(compiled)
}

export function getDeliveryStatsRows(): { summary: DbDeliveryStatsRow; avgAttemptsOnSuccess: number } {
  const summaryCompiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .select((eb) => [
      eb.fn.countAll<number>().as("total"),
      sql<number>`sum(case when status = 'delivered' then 1 else 0 end)`.as("delivered"),
      sql<number>`sum(case when status = 'failed' then 1 else 0 end)`.as("failed"),
      sql<number>`sum(case when status in ('queued', 'sending', 'retrying') then 1 else 0 end)`.as(
        "pending",
      ),
    ])
    .compile()
  const summary = runGet<DbDeliveryStatsRow>(summaryCompiled) ?? {
    total: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
  }

  const avgCompiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .select(sql<number>`coalesce(avg(attempts), 0)`.as("avg_attempts"))
    .where("status", "=", "delivered")
    .compile()
  const avgRow = runGet<{ avg_attempts: number }>(avgCompiled)

  return {
    summary,
    avgAttemptsOnSuccess: Math.round(Number(avgRow?.avg_attempts ?? 0) * 100) / 100,
  }
}
