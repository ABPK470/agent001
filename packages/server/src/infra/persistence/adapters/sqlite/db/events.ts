/**
 * Unified event log & webhook drain persistence.
 * Event durability lives on EventStore; this module keeps webhook drains
 * and re-exports the store helpers for existing callers.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb()
    .selectFrom("webhook_drain_configs")
    .selectAll()
    .orderBy("created_at")
    .compile()
  return runAll<DbWebhookDrain>(compiled)
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  const compiled = getPlatformDb()
    .selectFrom("webhook_drain_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbWebhookDrain>(compiled)
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  const compiled = getPlatformDb()
    .insertInto("webhook_drain_configs")
    .orReplace()
    .values(drain)
    .compile()
  runExec(compiled)
}

export function deleteWebhookDrain(id: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("webhook_drain_configs")
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}
