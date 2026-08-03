/**
 * EventStore — durable event_log behind a port.
 * Fanout enqueues; durability flushes off the SSE stack.
 *
 * Read/flush paths are async so the store can run on mssql/postgres
 * (sqlite execute-async wraps sync better-sqlite3 today).
 */

export interface DurableEvent {
  type: string
  createdAt: string
  actorUpn: string | null
  runId: string | null
  planId: string | null
  data: Record<string, unknown>
}

export interface EventListOpts {
  limit?: number
  before?: string
  after?: string
  since?: string
  until?: string
  types?: string[]
  excludeTypes?: string[]
  /** Column filter — preferred over JSON for hot list paths. */
  actorUpn?: string
  runId?: string
  planId?: string
}

export interface EventSearchOpts {
  limit?: number
  types?: string[]
  type_patterns?: string[]
  before?: string
  after?: string
  since?: string
  until?: string
}

export interface StoredEvent {
  id: number
  type: string
  data: string
  created_at: string
  actor_upn: string | null
  run_id: string | null
  plan_id: string | null
}

export interface EventStore {
  /** Enqueue for durable append — must not block the caller on disk I/O. */
  append(event: DurableEvent): void
  /** Drain the write queue (tests / shutdown). */
  flush(): Promise<void>
  list(opts?: EventListOpts): Promise<StoredEvent[]>
  search(q: string, opts?: EventSearchOpts): Promise<StoredEvent[]>
  listForPlanId(planId: string, opts?: { limit?: number }): Promise<StoredEvent[]>
  listForRunId(runId: string, opts?: { limit?: number }): Promise<StoredEvent[]>
  /** Approximate pending appends waiting for flush. */
  queueDepth(): number
}

/** Extract denormalized keys from event payload. */
export function durableKeysFromData(data: Record<string, unknown>): {
  actorUpn: string | null
  runId: string | null
  planId: string | null
} {
  const actorRaw =
    (typeof data["actorUpn"] === "string" && data["actorUpn"]) ||
    (typeof data["upn"] === "string" && data["upn"]) ||
    (typeof data["userUpn"] === "string" && data["userUpn"]) ||
    null
  const actorUpn = actorRaw ? actorRaw.trim().toLowerCase() : null
  const runId = typeof data["runId"] === "string" && data["runId"] ? data["runId"] : null
  const planId = typeof data["planId"] === "string" && data["planId"] ? data["planId"] : null
  return { actorUpn, runId, planId }
}

export function toDurableEvent(
  type: string,
  data: Record<string, unknown>,
  createdAt: string,
): DurableEvent {
  const keys = durableKeysFromData(data)
  return {
    type,
    createdAt,
    actorUpn: keys.actorUpn,
    runId: keys.runId,
    planId: keys.planId,
    data,
  }
}
