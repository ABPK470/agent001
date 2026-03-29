/**
 * In-memory implementations of governance infrastructure.
 *
 * These power audit, policy, learning, and event broadcast during a single run.
 * Each run gets fresh instances — no cross-run state.
 */

import type { AuditEntry, ExecutionRecord, AgentRun } from "./models.js"
import type { AuditRepository, EventBus, ExecutionRecordRepository, RunRepository } from "./interfaces.js"
import type { DomainEvent } from "./events.js"

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
  private handlers = new Map<string, Handler[]>()
  private _history: DomainEvent[] = []

  subscribe(eventType: string, handler: Handler): void {
    const list = this.handlers.get(eventType) ?? []
    list.push(handler)
    this.handlers.set(eventType, list)
  }

  async publish(event: DomainEvent): Promise<void> {
    this._history.push(event)
    const list = this.handlers.get(event.type) ?? []
    for (const handler of list) {
      try { await handler(event) }
      catch (err) { console.error(`Event handler error for ${event.type}:`, err) }
    }
  }

  get history(): readonly DomainEvent[] { return this._history }
}
