/**
 * SQLite EventStore — batched durable append off the SSE hot path.
 */

import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec } from "../../../schema/execute.js"
import { getPlatformStore } from "../platform-store.js"
import type {
  DurableEvent,
  EventListOpts,
  EventSearchOpts,
  EventStore,
  StoredEvent,
} from "../../../../../ports/event-store.js"
import { toDurableEvent } from "../../../../../ports/event-store.js"

const BATCH_SIZE = 64

export class SqliteEventStore implements EventStore {
  private readonly pending: DurableEvent[] = []
  private flushScheduled = false
  private lastFlushMs = 0

  append(event: DurableEvent): void {
    this.pending.push(event)
    this.scheduleFlush()
  }

  queueDepth(): number {
    return this.pending.length
  }

  /** Last flush duration in ms (for cheap counters). */
  lastFlushDurationMs(): number {
    return this.lastFlushMs
  }

  flush(): void {
    this.flushScheduled = false
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, this.pending.length)
    const started = Date.now()
    try {
      this.insertBatch(batch)
    } catch (err: unknown) {
      if (isDatabaseClosed(err)) {
        // Teardown / shutdown — named drop, not silent forever-retry.
        console.error("[mia] event_store.flush skipped; database closed", err)
        return
      }
      // Named failure — re-queue so durability is not silently dropped.
      this.pending.unshift(...batch)
      console.error("[mia] event_store.flush failed; re-queued", err)
      this.scheduleFlush()
      throw err
    } finally {
      this.lastFlushMs = Date.now() - started
    }
  }

  list(opts?: EventListOpts): StoredEvent[] {
    this.flush()
    const limit = opts?.limit ?? 200
    let query = getPlatformDb().selectFrom("event_log").selectAll()

    if (opts?.before) query = query.where("created_at", "<", opts.before)
    if (opts?.after) query = query.where("created_at", ">", opts.after)
    if (opts?.since) query = query.where("created_at", ">=", opts.since)
    if (opts?.until) query = query.where("created_at", "<=", opts.until)
    if (opts?.types && opts.types.length > 0) {
      query = query.where("type", "in", [...opts.types])
    }
    if (opts?.excludeTypes && opts.excludeTypes.length > 0) {
      query = query.where("type", "not in", [...opts.excludeTypes])
    }
    if (opts?.actorUpn) {
      query = query.where("actor_upn", "=", opts.actorUpn.trim().toLowerCase())
    }
    if (opts?.runId) query = query.where("run_id", "=", opts.runId)
    if (opts?.planId) query = query.where("plan_id", "=", opts.planId)

    const compiled = query.orderBy("created_at", "desc").limit(limit).compile()
    return runAll<StoredEvent>(compiled)
  }

  search(q: string, opts?: EventSearchOpts): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 200, 1000)
    let query = getPlatformDb().selectFrom("event_log").selectAll()
    let hasConditions = false

    if (q.length >= 2) {
      const words = q.split(/\s+/).filter((w) => w.length >= 2)
      for (const word of words) {
        const like = `%${word}%`
        query = query.where((eb) => eb.or([eb("data", "like", like), eb("type", "like", like)]))
        hasConditions = true
      }
    }
    if (opts?.before) {
      query = query.where("created_at", "<", opts.before)
      hasConditions = true
    }
    if (opts?.after) {
      query = query.where("created_at", ">", opts.after)
      hasConditions = true
    }
    if (opts?.since) {
      query = query.where("created_at", ">=", opts.since)
      hasConditions = true
    }
    if (opts?.until) {
      query = query.where("created_at", "<=", opts.until)
      hasConditions = true
    }
    if (opts?.types?.length) {
      query = query.where("type", "in", [...opts.types])
      hasConditions = true
    }
    if (opts?.type_patterns?.length) {
      query = query.where((eb) =>
        eb.or(opts.type_patterns!.map((p) => eb("type", "like", `%${p}%`))),
      )
      hasConditions = true
    }

    if (!hasConditions) return []

    const compiled = query.orderBy("created_at", "desc").limit(limit).compile()
    return runAll<StoredEvent>(compiled)
  }

  listForPlanId(planId: string, opts?: { limit?: number }): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 20_000, 50_000)

    const primaryCompiled = getPlatformDb()
      .selectFrom("event_log")
      .selectAll()
      .where("type", "like", "sync.%")
      .where((eb) =>
        eb.or([eb("plan_id", "=", planId), eb(sql`json_extract(data, '$.opId')`, "=", planId)]),
      )
      .orderBy("created_at", "asc")
      .limit(limit)
      .compile()
    const primary = runAll<StoredEvent>(primaryCompiled)

    const previewIds = new Set<string>()
    for (const row of primary) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>
        for (const key of ["previewId", "opId"] as const) {
          const id = data[key]
          if (typeof id === "string" && id.length > 0 && id !== planId) previewIds.add(id)
        }
      } catch (err: unknown) {
        console.error("[mia]", err)
      }
    }

    if (previewIds.size === 0) return primary

    const previewIdsArray = [...previewIds]
    const correlatedCompiled = getPlatformDb()
      .selectFrom("event_log")
      .selectAll()
      .where("type", "like", "sync.%")
      .where((eb) =>
        eb.or([
          eb("plan_id", "in", previewIdsArray),
          eb(sql`json_extract(data, '$.opId')`, "in", previewIdsArray),
        ]),
      )
      .orderBy("created_at", "asc")
      .compile()
    const correlated = runAll<StoredEvent>(correlatedCompiled)

    const byId = new Map<number, StoredEvent>()
    for (const row of [...primary, ...correlated]) byId.set(row.id, row)
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  listForRunId(runId: string, opts?: { limit?: number }): StoredEvent[] {
    this.flush()
    const limit = Math.min(opts?.limit ?? 20_000, 50_000)
    const compiled = getPlatformDb()
      .selectFrom("event_log")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .limit(limit)
      .compile()
    return runAll<StoredEvent>(compiled)
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Off the SSE stack — microtask then setImmediate for a short batch window.
    queueMicrotask(() => {
      setImmediate(() => {
        try {
          this.flush()
        } catch (err: unknown) {
          console.error("[mia] event_store.scheduled_flush", err)
        }
      })
    })
  }

  private insertBatch(batch: DurableEvent[]): void {
    getPlatformStore().transaction(() => {
      for (let i = 0; i < batch.length; i += BATCH_SIZE) {
        const slice = batch.slice(i, i + BATCH_SIZE)
        for (const e of slice) {
          const compiled = getPlatformDb()
            .insertInto("event_log")
            .values({
              type: e.type,
              data: JSON.stringify(e.data),
              created_at: e.createdAt,
              actor_upn: e.actorUpn,
              run_id: e.runId,
              plan_id: e.planId,
            })
            .compile()
          runExec(compiled)
        }
      }
    })
  }
}

const _default = new SqliteEventStore()

export function getEventStore(): EventStore {
  return _default
}

/** Sync convenience used by existing callers / broadcaster. */
export function saveEvent(type: string, data: Record<string, unknown>, timestamp: string): void {
  _default.append(toDurableEvent(type, data, timestamp))
}

export function listEvents(opts?: EventListOpts): StoredEvent[] {
  return _default.list(opts)
}

export function searchEvents(q: string, opts?: EventSearchOpts): StoredEvent[] {
  return _default.search(q, opts)
}

export function listEventsForPlanId(planId: string, opts?: { limit?: number }): StoredEvent[] {
  return _default.listForPlanId(planId, opts)
}

export function listEventsForRunId(runId: string, opts?: { limit?: number }): StoredEvent[] {
  return _default.listForRunId(runId, opts)
}

export function flushEventStore(): void {
  _default.flush()
}

function isDatabaseClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not open|closed|readonly/i.test(msg)
}
