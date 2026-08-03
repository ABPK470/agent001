import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync, runInsertIdAsync } from "../../../schema/execute-async.js"
import { platformNow } from "../../../schema/sql-time.js"
import { upsertRowAsync } from "../../../schema/upsert.js"

export interface NotificationRouteRow {
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

export interface NotificationLogRow {
  id: number
  route_id: string | null
  event_type: string
  channel: string
  target: string
  payload_json: string
  status: "sent" | "retrying" | "dlq" | "suppressed"
  attempts: number
  last_error: string | null
  created_at: string
  sent_at: string | null
}

export async function listEnabledRoutesForEvent(tenantId: string, eventType: string): Promise<NotificationRouteRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("event_type", "=", eventType)
    .where("enabled", "=", 1)
    .compile()
  return await runAllAsync<NotificationRouteRow>(compiled)
}

export async function appendNotificationLog(input: {
  routeId: string
  eventType: string
  channel: string
  target: string
  payloadJson: string
}): Promise<number> {
  const compiled = getPlatformDb()
    .insertInto("notification_log")
    .values({
      route_id: input.routeId,
      event_type: input.eventType,
      channel: input.channel,
      target: input.target,
      payload_json: input.payloadJson,
      status: "retrying",
      attempts: 0,
      created_at: platformNow(),
    })
    .compile()
  return await runInsertIdAsync(compiled)
}

export async function markNotificationLogAttempt(
  id: number,
  attempts: number,
  error: string,
  status: "retrying" | "dlq"
): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("notification_log")
    .set({ attempts, last_error: error, status })
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function markNotificationLogSent(id: number, attempts: number): Promise<void> {
  const compiled = getPlatformDb()
    .updateTable("notification_log")
    .set({
      attempts,
      status: "sent",
      sent_at: platformNow(),
      last_error: null,
    })
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function upsertNotificationRouteRow(input: {
  id: string
  tenantId: string
  eventType: string
  filterJson: string
  channel: string
  target: string
  enabled: number
  updatedBy: string
}): Promise<void> {
  const now = platformNow()
  await upsertRowAsync({
    table: "notification_route_configs",
    keys: { id: input.id },
    insert: {
      id: input.id,
      tenant_id: input.tenantId,
      event_type: input.eventType,
      filter_json: input.filterJson,
      channel: input.channel,
      target: input.target,
      enabled: input.enabled,
      updated_at: now,
      updated_by: input.updatedBy,
    },
    update: {
      tenant_id: input.tenantId,
      event_type: input.eventType,
      filter_json: input.filterJson,
      channel: input.channel,
      target: input.target,
      enabled: input.enabled,
      updated_at: now,
      updated_by: input.updatedBy,
    },
  })
}

export async function getNotificationRouteRow(id: string): Promise<NotificationRouteRow | null> {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<NotificationRouteRow>(compiled) ?? null
}

export async function listNotificationRouteRows(tenantId: string): Promise<NotificationRouteRow[]> {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("event_type")
    .orderBy("channel")
    .compile()
  return await runAllAsync<NotificationRouteRow>(compiled)
}

export async function deleteNotificationRouteRow(id: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("notification_route_configs")
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function listNotificationLogRows(
  filter: { status?: NotificationLogRow["status"]; limit?: number } = {}
): Promise<NotificationLogRow[]> {
  let query = getPlatformDb().selectFrom("notification_log").selectAll()
  if (filter.status) {
    query = query.where("status", "=", filter.status)
  }
  const compiled = query
    .orderBy("created_at", "desc")
    .limit(filter.limit ?? 100)
    .compile()
  return await runAllAsync<NotificationLogRow>(compiled)
}
