/**
 * Infrastructure types and factories for the governance layer.
 *
 * Extracted from governance.ts to keep that file under the 450-LOC threshold.
 * @module
 */

import { randomUUID } from "node:crypto"
import {
    type AgentRun,
    type AuditEntry,
    AuditService,
    Learner,
    MemoryAuditRepository,
    MemoryEventBus,
    MemoryExecutionRecordRepository,
    MemoryRunRepository,
    RulePolicyEvaluator,
    type Step,
    StepStatus,
} from "../engine/index.js"

// ── Engine infrastructure ────────────────────────────────────────

export interface EngineServices {
  runRepo: InstanceType<typeof MemoryRunRepository>
  auditService: AuditService
  policyEvaluator: RulePolicyEvaluator
  learner: Learner
  eventBus: MemoryEventBus
}

/** Creates a default set of engine services (in-memory). */
export function createEngineServices(): EngineServices {
  const runRepo = new MemoryRunRepository()
  const auditRepo = new MemoryAuditRepository()
  const recordRepo = new MemoryExecutionRecordRepository()
  const eventBus = new MemoryEventBus()

  return {
    runRepo,
    auditService: new AuditService(auditRepo),
    policyEvaluator: new RulePolicyEvaluator(),
    learner: new Learner(recordRepo),
    eventBus,
  }
}

// ── Governed result ──────────────────────────────────────────────

export interface GovernedResult {
  /** The agent's final answer. */
  answer: string
  /** Full run with all steps — shows exactly what happened. */
  run: AgentRun
  /** Audit trail — immutable log of every action. */
  auditTrail: AuditEntry[]
  /** Execution records — performance metrics per tool call. */
  stats: Map<string, { calls: number, avgMs: number, failures: number }>
}

// ── Run state (shared between governed tools) ────────────────────

export interface RunState {
  run: AgentRun
  actor: string
  stepCounter: number
}

// ── Build a Step for a tool call ─────────────────────────────────

export function createToolStep(
  toolName: string,
  args: Record<string, unknown>,
  state: RunState,
): Step {
  const order = state.stepCounter++
  return {
    id: randomUUID(),
    definitionId: `tool-${toolName}-${order}`,
    name: `${toolName} (#${order})`,
    action: toolName,
    input: args,
    condition: null,
    onError: "continue",
    status: StepStatus.Pending,
    order,
    output: {},
    error: null,
    startedAt: null,
    completedAt: null,
  }
}
