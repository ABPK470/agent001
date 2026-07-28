/**
 * Unified event log & webhook drain persistence.
 * Event durability lives on EventStore; this module keeps webhook drains
 * and re-exports the store helpers for existing callers.
 */

import { getDb } from "../connection.js"

export type { StoredEvent as DbEvent } from "../../../../../ports/event-store.js"
export {
  flushEventStore,
  getEventStore,
  listEvents,
  listEventsForPlanId,
  listEventsForRunId,
  saveEvent,
  searchEvents,
} from "./event-store.js"

export interface DbWebhookDrain {
  id: string
  url: string
  secret: string
  event_filters: string // JSON array of type prefixes, e.g. ["run.", "audit"]
  enabled: number // 0 or 1
  created_at: string
  updated_at: string
}

export function listWebhookDrains(): DbWebhookDrain[] {
  return getDb().prepare("SELECT * FROM webhook_drain_configs ORDER BY created_at").all() as DbWebhookDrain[]
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  return getDb().prepare("SELECT * FROM webhook_drain_configs WHERE id = ?").get(id) as
    | DbWebhookDrain
    | undefined
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO webhook_drain_configs (id, url, secret, event_filters, enabled, created_at, updated_at)
    VALUES (@id, @url, @secret, @event_filters, @enabled, @created_at, @updated_at)
  `,
    )
    .run(drain)
}

export function deleteWebhookDrain(id: string): void {
  getDb().prepare("DELETE FROM webhook_drain_configs WHERE id = ?").run(id)
}
