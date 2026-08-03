import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet, runInsertId } from "../../../schema/execute.js"
import { platformNow } from "../../../schema/sql-time.js"

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

export function listEnabledRoutesForEvent(tenantId: string, eventType: string): NotificationRouteRow[] {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("event_type", "=", eventType)
    .where("enabled", "=", 1)
    .compile()
  return runAll<NotificationRouteRow>(compiled)
}

export function appendNotificationLog(input: {
  routeId: string
  eventType: string
  channel: string
  target: string
  payloadJson: string
}): number {
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
  return runInsertId(compiled)
}

export function markNotificationLogAttempt(
  id: number,
  attempts: number,
  error: string,
  status: "retrying" | "dlq"
): void {
  const compiled = getPlatformDb()
    .updateTable("notification_log")
    .set({ attempts, last_error: error, status })
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function markNotificationLogSent(id: number, attempts: number): void {
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
  runExec(compiled)
}

export function upsertNotificationRouteRow(input: {
  id: string
  tenantId: string
  eventType: string
  filterJson: string
  channel: string
  target: string
  enabled: number
  updatedBy: string
}): void {
  const compiled = getPlatformDb()
    .insertInto("notification_route_configs")
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      event_type: input.eventType,
      filter_json: input.filterJson,
      channel: input.channel,
      target: input.target,
      enabled: input.enabled,
      updated_at: platformNow(),
      updated_by: input.updatedBy,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        tenant_id: input.tenantId,
        event_type: input.eventType,
        filter_json: input.filterJson,
        channel: input.channel,
        target: input.target,
        enabled: input.enabled,
        updated_at: platformNow(),
        updated_by: input.updatedBy,
      }),
    )
    .compile()
  runExec(compiled)
}

export function getNotificationRouteRow(id: string): NotificationRouteRow | null {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<NotificationRouteRow>(compiled) ?? null
}

export function listNotificationRouteRows(tenantId: string): NotificationRouteRow[] {
  const compiled = getPlatformDb()
    .selectFrom("notification_route_configs")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .orderBy("event_type")
    .orderBy("channel")
    .compile()
  return runAll<NotificationRouteRow>(compiled)
}

export function deleteNotificationRouteRow(id: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("notification_route_configs")
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function listNotificationLogRows(
  filter: { status?: NotificationLogRow["status"]; limit?: number } = {}
): NotificationLogRow[] {
  let query = getPlatformDb().selectFrom("notification_log").selectAll()
  if (filter.status) {
    query = query.where("status", "=", filter.status)
  }
  const compiled = query
    .orderBy("created_at", "desc")
    .limit(filter.limit ?? 100)
    .compile()
  return runAll<NotificationLogRow>(compiled)
}
