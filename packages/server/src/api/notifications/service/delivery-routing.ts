import { parseBoundaryJson } from "../../../internal/parse-json.js"

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
import {
  appendNotificationLog,
  deleteNotificationRouteRow,
  getNotificationRouteRow,
  listEnabledRoutesForEvent,
  listNotificationLogRows,
  listNotificationRouteRows,
  markNotificationLogAttempt,
  markNotificationLogSent,
  upsertNotificationRouteRow,
  type NotificationLogRow,
  type NotificationRouteRow
} from "../../../infra/persistence/sqlite.js"
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
export async function dispatchNotification(ev: DispatchEvent): Promise<void> {
  const routes = await listMatchingRoutes(ev)
  for (const r of routes) {
    void deliverWithRetry(r, ev).catch((err: unknown) => { console.error("[mia]", err) })
  }
}

export async function listMatchingRoutes(ev: DispatchEvent): Promise<NotificationRoute[]> {
  const rows = await listEnabledRoutesForEvent(ev.tenantId, ev.eventType)
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
  const logId = await appendLogRow(route, ev, body)

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
      await markLogSent(logId, attempt)
      broadcast({
        type: EventType.SyncNotificationDelivered,
        data: { routeId: route.id, channel: route.channel, eventType: ev.eventType }
      })
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isLast = attempt === MAX_ATTEMPTS
      await markLogAttempt(logId, attempt, msg, isLast ? "dlq" : "retrying")
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

async function appendLogRow(
  route: NotificationRoute,
  ev: DispatchEvent,
  body: { subject: string; text: string }
): Promise<number> {
  return await appendNotificationLog({
    routeId: route.id,
    eventType: ev.eventType,
    channel: route.channel,
    target: route.target,
    payloadJson: JSON.stringify({ ev, body })
  })
}

async function markLogAttempt(id: number, attempts: number, error: string, status: "retrying" | "dlq"): Promise<void> {
  await markNotificationLogAttempt(id, attempts, error, status)
}

async function markLogSent(id: number, attempts: number): Promise<void> {
  await markNotificationLogSent(id, attempts)
}

// ── CRUD ───────────────────────────────────────────────────────

function rowToRoute(r: NotificationRouteRow): NotificationRoute {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    eventType: r.event_type,
    filter: parseBoundaryJson(r.filter_json) as NotificationFilter,
    channel: r.channel as NotificationChannel,
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

export async function upsertNotificationRoute(i: UpsertRouteInput): Promise<NotificationRoute> {
  const id = i.id ?? randomUUID()
  await upsertNotificationRouteRow({
    id,
    tenantId: i.tenantId,
    eventType: i.eventType,
    filterJson: JSON.stringify(i.filter),
    channel: i.channel,
    target: i.target,
    enabled: i.enabled ? 1 : 0,
    updatedBy: i.actor
  })
  const row = await getNotificationRouteRow(id)
  if (!row) throw new Error(`notification route ${id} missing after upsert`)
  return rowToRoute(row)
}

export async function listNotificationRoutes(tenantId: string): Promise<NotificationRoute[]> {
  return (await listNotificationRouteRows(tenantId)).map(rowToRoute)
}

export async function deleteNotificationRoute(id: string): Promise<void> {
  await deleteNotificationRouteRow(id)
}

export type { NotificationLogRow }

export async function listNotificationLog(
  filter: { status?: NotificationLogRow["status"]; limit?: number } = {}
): Promise<NotificationLogRow[]> {
  return await listNotificationLogRows(filter)
}
