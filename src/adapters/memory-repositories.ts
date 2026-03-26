/**
 * In-memory repository implementations.
 *
 * Default adapters for single-process deployments.
 * Swap for Postgres/Redis via the same interfaces when you need durability.
 */

import { ApprovalStatus } from "../domain/enums.js"
import type {
    ApprovalRequest,
    AuditEntry,
    ExecutionRecord,
    Workflow,
    WorkflowRun,
} from "../domain/models.js"
import type {
    ApprovalRepository,
    AuditRepository,
    ExecutionRecordRepository,
    RunRepository,
    WorkflowRepository,
} from "../ports/repositories.js"

export class MemoryWorkflowRepository implements WorkflowRepository {
  private store = new Map<string, Workflow>()

  async save(wf: Workflow): Promise<void> {
    this.store.set(wf.id, wf)
  }
  async get(id: string): Promise<Workflow | null> {
    return this.store.get(id) ?? null
  }
  async listAll(): Promise<Workflow[]> {
    return [...this.store.values()]
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }
}

export class MemoryRunRepository implements RunRepository {
  private store = new Map<string, WorkflowRun>()

  async save(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, run)
  }
  async get(id: string): Promise<WorkflowRun | null> {
    return this.store.get(id) ?? null
  }
  async listByWorkflow(workflowId: string): Promise<WorkflowRun[]> {
    return [...this.store.values()].filter((r) => r.workflowId === workflowId)
  }
}

export class MemoryApprovalRepository implements ApprovalRepository {
  private store = new Map<string, ApprovalRequest>()

  async save(req: ApprovalRequest): Promise<void> {
    this.store.set(req.id, req)
  }
  async get(id: string): Promise<ApprovalRequest | null> {
    return this.store.get(id) ?? null
  }
  async listPending(runId?: string): Promise<ApprovalRequest[]> {
    return [...this.store.values()].filter(
      (r) =>
        r.status === ApprovalStatus.Pending && (!runId || r.runId === runId),
    )
  }
}

export class MemoryAuditRepository implements AuditRepository {
  private entries: AuditEntry[] = []

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry)
  }
  async listByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<AuditEntry[]> {
    return this.entries.filter(
      (e) => e.resourceType === resourceType && e.resourceId === resourceId,
    )
  }
}

export class MemoryExecutionRecordRepository implements ExecutionRecordRepository {
  private records: ExecutionRecord[] = []

  async append(record: ExecutionRecord): Promise<void> {
    this.records.push(record)
  }
  async listByRun(runId: string): Promise<ExecutionRecord[]> {
    return this.records.filter((r) => r.runId === runId)
  }
  async listByAction(action: string): Promise<ExecutionRecord[]> {
    return this.records.filter((r) => r.action === action)
  }
}
