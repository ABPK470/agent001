import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

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

export async function findConversationByChannelAndSender(
  channelType: string,
  senderId: string
): Promise<DbConversationRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("channel_type", "=", channelType)
    .where("sender_id", "=", senderId)
    .compile()
  return await runGetAsync<DbConversationRow>(compiled) ?? null
}

export async function upsertConversationRow(row: {
  id: string
  channel_type: string
  sender_id: string
  sender_name: string | null
  active_run_id: string | null
  thread_id: string | null
  created_at: string
  updated_at: string
}): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("conversations")
    .orReplace()
    .values(row)
    .compile()
  await runExecAsync(compiled)
}

export async function updateConversationThreadId(id: string, threadId: string, updatedAt: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("conversations")
    .set({ thread_id: threadId, updated_at: updatedAt })
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function updateConversationActiveRun(id: string, runId: string | null, updatedAt: string): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("conversations")
    .set({ active_run_id: runId, updated_at: updatedAt })
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function getConversationRow(id: string): Promise<DbConversationRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<DbConversationRow>(compiled) ?? null
}

export async function getConversationRowByRunId(runId: string): Promise<DbConversationRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .where("active_run_id", "=", runId)
    .compile()
  return await runGetAsync<DbConversationRow>(compiled) ?? null
}

export async function listConversationRows(): Promise<DbConversationRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("conversations")
    .selectAll()
    .orderBy("updated_at", "desc")
    .compile()
  return await runAllAsync<DbConversationRow>(compiled)
}

export async function insertOutboundMessageRow(row: {
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
}): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("outbound_messages")
    .values(row)
    .compile()
  await runExecAsync(compiled)
}

export async function updateOutboundMessageStatus(input: {
  id: string
  status: string
  error: string | null
  nextRetryAt: string | null
  deliveredAt: string | null
}): Promise<void> {
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
  await runExecAsync(compiled)
}

export async function listPendingOutboundMessageRows(): Promise<DbOutboundMessageRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .selectAll()
    .where("status", "in", ["queued", "sending", "retrying"])
    .orderBy("created_at")
    .compile()
  return await runAllAsync<DbOutboundMessageRow>(compiled)
}

export async function insertDeliveryAttemptRow(input: {
  messageId: string
  attempt: number
  status: string
  error: string | null
  durationMs: number
  createdAt: string
}): Promise<void> {
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
  await runExecAsync(compiled)
}

export async function updateOutboundMessageAttempts(messageId: string, attempt: number): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("outbound_messages")
    .set({ attempts: attempt })
    .where("id", "=", messageId)
    .compile()
  await runExecAsync(compiled)
}

export async function upsertChannelConfigRow(row: {
  type: string
  access_token: string
  verify_token: string
  app_secret: string
  platform_id: string
  created_at: string
  updated_at: string
}): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("channel_configs")
    .orReplace()
    .values(row)
    .compile()
  await runExecAsync(compiled)
}

export async function getChannelConfigRow(type: string): Promise<DbChannelConfigRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("channel_configs")
    .selectAll()
    .where("type", "=", type)
    .compile()
  return await runGetAsync<DbChannelConfigRow>(compiled) ?? null
}

export async function listChannelConfigRows(): Promise<DbChannelConfigRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("channel_configs")
    .selectAll()
    .orderBy("type")
    .compile()
  return await runAllAsync<DbChannelConfigRow>(compiled)
}

export async function deleteChannelConfigRow(type: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("channel_configs")
    .where("type", "=", type)
    .compile()
  await runExecAsync(compiled)
}

export async function listOutboundMessageRows(conversationId: string, limit: number): Promise<DbOutboundMessageRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("outbound_messages")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return await runAllAsync<DbOutboundMessageRow>(compiled)
}

export async function listDeliveryAttemptRows(messageId: string): Promise<DbDeliveryAttemptRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("delivery_attempts")
    .selectAll()
    .where("message_id", "=", messageId)
    .orderBy("attempt_number")
    .compile()
  return await runAllAsync<DbDeliveryAttemptRow>(compiled)
}

export async function getDeliveryStatsRows(): Promise<{  summary: DbDeliveryStatsRow; avgAttemptsOnSuccess: number  }> {
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
  const summary = await runGetAsync<DbDeliveryStatsRow>(summaryCompiled) ?? {
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
  const avgRow = await runGetAsync<{ avg_attempts: number }>(avgCompiled)

  return {
    summary,
    avgAttemptsOnSuccess: Math.round(Number(avgRow?.avg_attempts ?? 0) * 100) / 100,
  }
}
