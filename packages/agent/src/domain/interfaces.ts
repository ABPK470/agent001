/** Service interfaces — contracts for governance infrastructure. */

import type { DomainEvent } from "./events.js"
import type { AgentRun, AuditEntry, ExecutionRecord, Step } from "./models.js"

// ── Repositories ─────────────────────────────────────────────────

export interface RunRepository {
  save(run: AgentRun): Promise<void>
  get(runId: string): Promise<AgentRun | null>
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>
  listByResource(resourceType: string, resourceId: string): Promise<AuditEntry[]>
}

export interface ExecutionRecordRepository {
  append(record: ExecutionRecord): Promise<void>
  listByAction(action: string): Promise<ExecutionRecord[]>
}

// ── Services ─────────────────────────────────────────────────────

export interface PolicyEvaluator {
  evaluatePreStep(run: AgentRun, step: Step): Promise<string | null>
}

export interface EventBus {
  publish(event: DomainEvent): Promise<void>
  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void
}
