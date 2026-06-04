/**
 * In-memory implementations of governance infrastructure.
 *
 * These power audit, policy, learning, and event broadcast during a single run.
 * Each run gets fresh instances — no cross-run state.
 */

import type { DomainEvent } from "./events.js"
import type { AuditRepository, EventBus, ExecutionRecordRepository, RunRepository, Unsubscribe } from "./interfaces.js"
import type { AgentRun, AuditEntry, ExecutionRecord } from "./models.js"

// ── Repositories ─────────────────────────────────────────────────

export class MemoryRunRepository implements RunRepository {
  private store = new Map<string, AgentRun>()
  async save(run: AgentRun): Promise<void> { this.store.set(run.id, run) }
  async get(id: string): Promise<AgentRun | null> { return this.store.get(id) ?? null }
}

export class MemoryAuditRepository implements AuditRepository {
  private entries: AuditEntry[] = []
  async append(entry: AuditEntry): Promise<void> { this.entries.push(entry) }
  async listByResource(resourceType: string, resourceId: string): Promise<AuditEntry[]> {
    return this.entries.filter(e => e.resourceType === resourceType && e.resourceId === resourceId)
  }
}

export class MemoryExecutionRecordRepository implements ExecutionRecordRepository {
  private records: ExecutionRecord[] = []
  async append(record: ExecutionRecord): Promise<void> { this.records.push(record) }
  async listByAction(action: string): Promise<ExecutionRecord[]> {
    return this.records.filter(r => r.action === action)
  }
}

// ── Event Bus ────────────────────────────────────────────────────

type Handler = (event: DomainEvent) => Promise<void>

export class MemoryEventBus implements EventBus {
  private handlers = new Map<string, Set<Handler>>()
  private _history: DomainEvent[] = []

  subscribe(eventType: string, handler: Handler): Unsubscribe {
    const listeners = this.handlers.get(eventType) ?? new Set<Handler>()
    listeners.add(handler)
    this.handlers.set(eventType, listeners)

    return () => {
      const current = this.handlers.get(eventType)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) {
        this.handlers.delete(eventType)
      }
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    this._history.push(event)
    const listeners = this.handlers.get(event.type)
    if (!listeners) return

    for (const handler of [...listeners]) {
      try { await handler(event) }
      catch (err) { console.error(`Event handler error for ${event.type}:`, err) }
    }
  }

  get history(): readonly DomainEvent[] { return this._history }
}
