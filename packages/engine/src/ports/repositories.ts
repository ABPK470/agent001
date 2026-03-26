/**
 * Port interfaces — contracts between the engine and infrastructure.
 *
 * Infrastructure adapters (in-memory, Postgres, Redis) implement these.
 * The engine never depends on concrete adapters.
 */

import type {
    ApprovalRequest,
    AuditEntry,
    ExecutionRecord,
    Workflow,
    WorkflowRun,
} from "../domain/models.js"

export interface WorkflowRepository {
  save(workflow: Workflow): Promise<void>
  get(workflowId: string): Promise<Workflow | null>
  listAll(): Promise<Workflow[]>
  delete(workflowId: string): Promise<void>
}

export interface RunRepository {
  save(run: WorkflowRun): Promise<void>
  get(runId: string): Promise<WorkflowRun | null>
  listByWorkflow(workflowId: string): Promise<WorkflowRun[]>
}

export interface ApprovalRepository {
  save(request: ApprovalRequest): Promise<void>
  get(approvalId: string): Promise<ApprovalRequest | null>
  listPending(runId?: string): Promise<ApprovalRequest[]>
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>
  listByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<AuditEntry[]>
}

export interface ExecutionRecordRepository {
  append(record: ExecutionRecord): Promise<void>
  listByRun(runId: string): Promise<ExecutionRecord[]>
  listByAction(action: string): Promise<ExecutionRecord[]>
}
