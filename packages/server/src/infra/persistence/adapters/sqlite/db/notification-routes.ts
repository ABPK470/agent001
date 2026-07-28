import { getDb } from "../connection.js"

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
  return getDb()
    .prepare(
      `
    SELECT * FROM notification_route_configs
     WHERE tenant_id = ? AND event_type = ? AND enabled = 1
  `
    )
    .all(tenantId, eventType) as NotificationRouteRow[]
}

export function appendNotificationLog(input: {
  routeId: string
  eventType: string
  channel: string
  target: string
  payloadJson: string
}): number {
  const r = getDb()
    .prepare(
      `
    INSERT INTO notification_log (route_id, event_type, channel, target, payload_json, status, attempts)
    VALUES (?, ?, ?, ?, ?, 'retrying', 0)
  `
    )
    .run(input.routeId, input.eventType, input.channel, input.target, input.payloadJson)
  return Number(r.lastInsertRowid)
}

export function markNotificationLogAttempt(
  id: number,
  attempts: number,
  error: string,
  status: "retrying" | "dlq"
): void {
  getDb()
    .prepare(`UPDATE notification_log SET attempts = ?, last_error = ?, status = ? WHERE id = ?`)
    .run(attempts, error, status, id)
}

export function markNotificationLogSent(id: number, attempts: number): void {
  getDb()
    .prepare(
      `UPDATE notification_log SET attempts = ?, status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?`
    )
    .run(attempts, id)
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
  getDb()
    .prepare(
      `
    INSERT INTO notification_route_configs (id, tenant_id, event_type, filter_json, channel, target, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      tenant_id   = excluded.tenant_id,
      event_type  = excluded.event_type,
      filter_json = excluded.filter_json,
      channel     = excluded.channel,
      target      = excluded.target,
      enabled     = excluded.enabled,
      updated_at  = excluded.updated_at,
      updated_by  = excluded.updated_by
  `
    )
    .run(
      input.id,
      input.tenantId,
      input.eventType,
      input.filterJson,
      input.channel,
      input.target,
      input.enabled,
      input.updatedBy
    )
}

export function getNotificationRouteRow(id: string): NotificationRouteRow | null {
  return (
    (getDb().prepare(`SELECT * FROM notification_route_configs WHERE id = ?`).get(id) as
      | NotificationRouteRow
      | undefined) ?? null
  )
}

export function listNotificationRouteRows(tenantId: string): NotificationRouteRow[] {
  return getDb()
    .prepare(`SELECT * FROM notification_route_configs WHERE tenant_id = ? ORDER BY event_type, channel`)
    .all(tenantId) as NotificationRouteRow[]
}

export function deleteNotificationRouteRow(id: string): void {
  getDb().prepare(`DELETE FROM notification_route_configs WHERE id = ?`).run(id)
}

export function listNotificationLogRows(
  filter: { status?: NotificationLogRow["status"]; limit?: number } = {}
): NotificationLogRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.status) {
    where.push("status = ?")
    args.push(filter.status)
  }
  return getDb()
    .prepare(
      `
    SELECT * FROM notification_log
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC LIMIT ?
  `
    )
    .all(...args, filter.limit ?? 100) as NotificationLogRow[]
}
