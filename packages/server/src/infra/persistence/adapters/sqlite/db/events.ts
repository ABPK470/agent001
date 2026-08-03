/**
 * Unified event log & webhook drain persistence.
 * Event durability lives on EventStore; this module keeps webhook drains
 * and re-exports the store helpers for existing callers.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

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

export async function listWebhookDrains(): Promise<DbWebhookDrain[]> {
  const compiled = getPlatformDb()
    .selectFrom("webhook_drain_configs")
    .selectAll()
    .orderBy("created_at")
    .compile()
  return await runAllAsync<DbWebhookDrain>(compiled)
}

export async function getWebhookDrain(id: string): Promise<DbWebhookDrain | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("webhook_drain_configs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<DbWebhookDrain>(compiled)
}

export async function saveWebhookDrain(drain: DbWebhookDrain): Promise<void> {
  const compiled = getPlatformDb()
    .insertInto("webhook_drain_configs")
    .orReplace()
    .values(drain)
    .compile()
  await runExecAsync(compiled)
}

export async function deleteWebhookDrain(id: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("webhook_drain_configs")
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}
