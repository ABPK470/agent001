/**
 * F1.10 — Notification delivery routing + persistence.
 *
 * Routes are stored in `notification_route_configs`; deliveries are logged in
 * `notification_log`. Each delivery is attempted up to `MAX_ATTEMPTS`
 * times with exponential backoff; on terminal failure the row is left
 * in `dlq` for an operator to inspect / replay.
 *
 * Filter expression (JSON in `filter_json`) is currently
 * `{ riskTier?: string[]; envPair?: string[]; entityType?: string[] }`
 * — all clauses AND-joined, missing clause means "any".
 */

import { EventType } from "@mia/shared-enums"
import { randomUUID } from "node:crypto"
import { broadcast } from "../../../infra/events/broadcaster.js"
import { getDb } from "../../../infra/persistence/sqlite.js"
import { deliverEmail } from "../adapters/email.js"
import { deliverSlack } from "../adapters/slack.js"
import { deliverTeams } from "../adapters/teams.js"
import { renderNotificationBody } from "./templates.js"

export const NotificationChannel = {
  Email: "email",
  Teams: "teams",
  Slack: "slack"
} as const
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel]

export interface NotificationRoute {
  id: string
  tenantId: string
  eventType: string
  filter: NotificationFilter
  channel: NotificationChannel
  target: string
  enabled: boolean
  updatedAt: string
  updatedBy: string
}

export interface NotificationFilter {
  riskTier?: readonly string[]
  envPair?: readonly string[]
  entityType?: readonly string[]
}

interface RouteRow {
  id: string
  tenant_id: string
  event_type: string
  filter_json: string
  channel: NotificationChannel
  target: string
  enabled: number
  updated_at: string
  updated_by: string
}

const RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

export interface DispatchEvent {
  tenantId: string
  eventType: string
  riskTier?: string
  envPair?: string
  entityType?: string
  /** Free-form context object passed verbatim to the template. */
  context: Record<string, unknown>
}

/**
 * Fan-out an event to matching routes. Each delivery runs in the
 * background (`void`) so the caller doesn't block; durable retry +
 * DLQ live in `notification_log`.
 */
export function dispatchNotification(ev: DispatchEvent): void {
  const routes = listMatchingRoutes(ev)
  for (const r of routes) {
    void deliverWithRetry(r, ev).catch((err: unknown) => { console.error("[mia]", err) })
  }
}

export function listMatchingRoutes(ev: DispatchEvent): NotificationRoute[] {
  const rows = getDb()
    .prepare(
      `
    SELECT * FROM notification_route_configs
     WHERE tenant_id = ? AND event_type = ? AND enabled = 1
  `
    )
    .all(ev.tenantId, ev.eventType) as RouteRow[]
  return rows.map(rowToRoute).filter((r) => matches(r.filter, ev))
}

function matches(f: NotificationFilter, ev: DispatchEvent): boolean {
  if (f.riskTier && ev.riskTier && !f.riskTier.includes(ev.riskTier)) return false
  if (f.envPair && ev.envPair && !f.envPair.includes(ev.envPair)) return false
  if (f.entityType && ev.entityType && !f.entityType.includes(ev.entityType)) return false
  return true
}

async function deliverWithRetry(route: NotificationRoute, ev: DispatchEvent): Promise<void> {
  const body = renderNotificationBody(ev.eventType, ev.context)
  const logId = appendLogRow(route, ev, body)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      switch (route.channel) {
        case "email":
          await deliverEmail({ target: route.target, body })
          break
        case "teams":
          await deliverTeams({ target: route.target, body })
          break
        case "slack":
          await deliverSlack({ target: route.target, body })
          break
      }
      markLogSent(logId, attempt)
      broadcast({
        type: EventType.SyncNotificationDelivered,
        data: { routeId: route.id, channel: route.channel, eventType: ev.eventType }
      })
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isLast = attempt === MAX_ATTEMPTS
      markLogAttempt(logId, attempt, msg, isLast ? "dlq" : "retrying")
      if (isLast) {
        broadcast({
          type: EventType.SyncNotificationFailed,
          data: { routeId: route.id, channel: route.channel, error: msg }
        })
        return
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 60_000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── persistence ────────────────────────────────────────────────

function appendLogRow(
  route: NotificationRoute,
  ev: DispatchEvent,
  body: { subject: string; text: string }
): number {
  const r = getDb()
    .prepare(
      `
    INSERT INTO notification_log (route_id, event_type, channel, target, payload_json, status, attempts)
    VALUES (?, ?, ?, ?, ?, 'retrying', 0)
  `
    )
    .run(route.id, ev.eventType, route.channel, route.target, JSON.stringify({ ev, body }))
  return Number(r.lastInsertRowid)
}

function markLogAttempt(id: number, attempts: number, error: string, status: "retrying" | "dlq"): void {
  getDb()
    .prepare(`UPDATE notification_log SET attempts = ?, last_error = ?, status = ? WHERE id = ?`)
    .run(attempts, error, status, id)
}

function markLogSent(id: number, attempts: number): void {
  getDb()
    .prepare(
      `UPDATE notification_log SET attempts = ?, status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?`
    )
    .run(attempts, id)
}

// ── CRUD ───────────────────────────────────────────────────────

function rowToRoute(r: RouteRow): NotificationRoute {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    eventType: r.event_type,
    filter: JSON.parse(r.filter_json) as NotificationFilter,
    channel: r.channel,
    target: r.target,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by
  }
}

export interface UpsertRouteInput {
  id?: string
  tenantId: string
  eventType: string
  filter: NotificationFilter
  channel: NotificationChannel
  target: string
  enabled: boolean
  actor: string
}

export function upsertNotificationRoute(i: UpsertRouteInput): NotificationRoute {
  const id = i.id ?? randomUUID()
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
      id,
      i.tenantId,
      i.eventType,
      JSON.stringify(i.filter),
      i.channel,
      i.target,
      i.enabled ? 1 : 0,
      i.actor
    )
  const row = getDb().prepare(`SELECT * FROM notification_route_configs WHERE id = ?`).get(id) as RouteRow
  return rowToRoute(row)
}

export function listNotificationRoutes(tenantId: string): NotificationRoute[] {
  const rows = getDb()
    .prepare(`SELECT * FROM notification_route_configs WHERE tenant_id = ? ORDER BY event_type, channel`)
    .all(tenantId) as RouteRow[]
  return rows.map(rowToRoute)
}

export function deleteNotificationRoute(id: string): void {
  getDb().prepare(`DELETE FROM notification_route_configs WHERE id = ?`).run(id)
}

export interface NotificationLogRow {
  id: number
  route_id: string | null
  event_type: string
  channel: NotificationChannel
  target: string
  payload_json: string
  status: "sent" | "retrying" | "dlq" | "suppressed"
  attempts: number
  last_error: string | null
  created_at: string
  sent_at: string | null
}

export function listNotificationLog(
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
