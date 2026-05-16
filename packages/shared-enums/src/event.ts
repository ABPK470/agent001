/**
 * EventType — exhaustive catalog of every event published on the
 * agent → server → client event bus.
 *
 * Wire format
 * -----------
 * String values match what is persisted in `event_log.type` and what
 * is shipped over SSE / HTTP, so the same constant resolves on both
 * sides of the wire.
 *
 * If a new event is introduced, ADD A MEMBER HERE FIRST. Every emit
 * site is statically typed against `EventType`, so missing members
 * fail compilation rather than persisting a stringly-typed value.
 *
 * Helpers below replace ad-hoc `t.endsWith(".completed")` /
 * `t.startsWith("sync.")` checks. They use the enum so adding a new
 * completion / failure event automatically surfaces via these helpers
 * if listed in the corresponding set.
 */

export const EventType = {
  // Run lifecycle
  RunQueued: "run.queued",
  RunStarted: "run.started",
  RunCompleted: "run.completed",
  RunFailed: "run.failed",
  RunCancelled: "run.cancelled",
  RunUserSafeFailure: "run.user_safe_failure",

  // Agent lifecycle (legacy / engine-side)
  AgentStarted: "agent.started",
  AgentCompleted: "agent.completed",
  AgentFailed: "agent.failed",
  AgentCancelled: "agent.cancelled",
  AgentThinking: "agent.thinking",
  AgentUserSafeFailure: "agent.user_safe_failure",

  // Step lifecycle
  StepStarted: "step.started",
  StepCompleted: "step.completed",
  StepFailed: "step.failed",

  // Tool calls
  ToolInvoked: "tool.invoked",
  ToolCompleted: "tool.completed",
  ToolFailed: "tool.failed",
  ToolBlocked: "tool.blocked",
  ToolDenied: "tool.denied",
  ToolCallExecuting: "tool_call.executing",
  ToolCallCompleted: "tool_call.completed",
  ToolCallKilled: "tool_call.killed",

  // Approvals + user input
  ApprovalRequired: "approval.required",
  UserInputRequired: "user_input.required",
  UserInputResponse: "user_input.response",

  // Streaming + telemetry
  AnswerChunk: "answer.chunk",
  StreamReset: "stream.reset",
  UsageUpdated: "usage.updated",
  CheckpointSaved: "checkpoint.saved",
  DebugTrace: "debug.trace",
  ApiRequest: "api.request",
  LogDetail: "log.detail",
  EventsConnected: "events.connected",

  // Delegation (engine-side)
  DelegationStarted: "delegation.started",
  DelegationIteration: "delegation.iteration",
  DelegationEnded: "delegation.ended",
  DelegationCompleted: "delegation.completed",
  DelegationFailed: "delegation.failed",
  DelegationParallelStarted: "delegation.parallel-started",
  DelegationParallelEnded: "delegation.parallel-ended",

  // Planner — coherent path
  PlannerStarted: "planner.started",
  PlannerCompleted: "planner.completed",
  PlannerFailed: "planner.failed",
  PlannerVerified: "planner.verified",
  PlannerVerification: "planner.verification",
  PlannerVerificationFollowup: "planner.verification.followup",
  PlannerPipelineStarted: "planner.pipeline.started",
  PlannerArchitectureState: "planner.architecture.state",
  PlannerPlatformUnconfigured: "planner.platform.unconfigured",
  PlannerRuntimeCompiled: "planner.runtime.compiled",
  PlannerValidationFailed: "planner.validation.failed",
  PlannerValidationRemediated: "planner.validation.remediated",
  PlannerIssueTimeline: "planner.issue.timeline",
  PlannerRepairPlan: "planner.repair.plan",
  PlannerRepairCompatibility: "planner.repair.compatibility",
  PlannerStepStarted: "planner.step.started",
  PlannerStepCompleted: "planner.step.completed",
  PlannerStepTransition: "planner.step.transition",
  PlannerCoherentBootstrap: "planner.coherent.bootstrap",
  PlannerCoherentStarted: "planner.coherent.started",
  PlannerCoherentBundle: "planner.coherent.bundle",
  PlannerCoherentMaterialized: "planner.coherent.materialized",
  PlannerCoherentVerified: "planner.coherent.verified",
  PlannerCoherentRepairRequired: "planner.coherent.repair.required",
  PlannerCoherentRepairEscalated: "planner.coherent.repair.escalated",
  PlannerCoherentHandoff: "planner.coherent.handoff",
  PlannerCoherentFailed: "planner.coherent.failed",
  PlannerDelegationStarted: "planner.delegation.started",
  PlannerDelegationIteration: "planner.delegation.iteration",
  PlannerDelegationEnded: "planner.delegation.ended",

  // Sync — preview
  SyncPreview: "sync.preview",
  SyncPreviewStarted: "sync.preview.started",
  SyncPreviewCompleted: "sync.preview.completed",
  SyncPreviewFailed: "sync.preview.failed",
  SyncPreviewTableStart: "sync.preview.table.start",
  SyncPreviewTableDone: "sync.preview.table.done",
  SyncPreviewTableFailed: "sync.preview.table.failed",

  // Sync — execute
  SyncExecute: "sync.execute",
  SyncExecuteStart: "sync.execute.start",
  SyncExecuteStarted: "sync.execute.started",
  SyncExecuteCompleted: "sync.execute.completed",
  SyncExecuteFailed: "sync.execute.failed",
  SyncExecuteStep: "sync.execute.step",
  SyncExecuteStepFailed: "sync.execute.step.failed",
  SyncExecuteTableStart: "sync.execute.table.start",
  SyncExecuteTableDone: "sync.execute.table.done",
  SyncExecuteArchiveProbe: "sync.execute.archive.probe",
  SyncExecuteArchiveProbeBatch: "sync.execute.archive.probe.batch",
  SyncExecuteArchiveSkipped: "sync.execute.archive.skipped",
  SyncExecuteDriftRevalidated: "sync.execute.drift.revalidated",

  // Sync — agent-bridge
  SyncAgentPreview: "sync.agent.preview",
  SyncAgentExecuteStarted: "sync.agent.execute.started",
  SyncAgentExecuteCompleted: "sync.agent.execute.completed",

  // Sync — environment maintenance
  SyncEnvUpdate: "sync_env.update",
  SyncEnvReset: "sync_env.reset",

  // Entity registry (Phase 0 config uplift)
  EntityRegistrySaved: "entity_registry.saved",
  EntityRegistryRetired: "entity_registry.retired",
  EntityRegistryStrategySaved: "entity_registry.strategy.saved",
  EntityRegistryImported: "entity_registry.imported",

  // Memory
  MemoryIngested: "memory.ingested",
  MemoryFiltered: "memory.filtered",
  MemoryRetrieved: "memory.retrieved",
  MemoryConsolidated: "memory.consolidated",

  // Procedural memory
  ProceduralStored: "procedural.stored",
  ProceduralFailed: "procedural.failed",

  // Attachments
  AttachmentUploaded: "attachment.uploaded",
  AttachmentImported: "attachment.imported",
  AttachmentPromoted: "attachment.promoted",
  AttachmentDeleted: "attachment.deleted",
  AttachmentPruned: "attachment.pruned",

  // Effects + rollback
  EffectRecorded: "effect.recorded",
  SnapshotCaptured: "snapshot.captured",
  RollbackStarted: "rollback.started",
  RollbackEffect: "rollback.effect",
  RollbackBlocked: "rollback.blocked",
  RollbackCompleted: "rollback.completed",

  // Channels / messaging
  MessageQueued: "message.queued",
  MessageDelivered: "message.delivered",
  MessageFailed: "message.failed",
  ConversationMessage: "conversation.message",

  // Cross-cutting
  Audit: "audit",
  Notification: "notification",

  // Sync — SQL trace events emitted from query helpers
  SyncPreviewSql: "sync.preview.sql",
  SyncExecuteSql: "sync.execute.sql",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

export const EVENT_TYPES: ReadonlyArray<EventType> = Object.values(EventType)

export const isEventType = (value: unknown): value is EventType =>
  typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value)

// ── Namespace classification ─────────────────────────────────────

export const EventNamespace = {
  Run: "run",
  Agent: "agent",
  Step: "step",
  Tool: "tool",
  ToolCall: "tool_call",
  Approval: "approval",
  UserInput: "user_input",
  Streaming: "streaming",
  Delegation: "delegation",
  Planner: "planner",
  Sync: "sync",
  SyncEnv: "sync_env",
  Memory: "memory",
  Procedural: "procedural",
  Attachment: "attachment",
  Effect: "effect",
  Rollback: "rollback",
  Message: "message",
  Conversation: "conversation",
  System: "system",
} as const

export type EventNamespace = (typeof EventNamespace)[keyof typeof EventNamespace]

const NAMESPACE_PREFIX: ReadonlyArray<readonly [string, EventNamespace]> = [
  ["run.",                EventNamespace.Run],
  ["agent.",              EventNamespace.Agent],
  ["step.",               EventNamespace.Step],
  ["tool_call.",          EventNamespace.ToolCall],
  ["tool.",               EventNamespace.Tool],
  ["approval.",           EventNamespace.Approval],
  ["user_input.",         EventNamespace.UserInput],
  ["delegation.",         EventNamespace.Delegation],
  ["planner.",            EventNamespace.Planner],
  ["sync_env.",           EventNamespace.SyncEnv],
  ["sync.",               EventNamespace.Sync],
  ["memory.",             EventNamespace.Memory],
  ["procedural.",         EventNamespace.Procedural],
  ["attachment.",         EventNamespace.Attachment],
  ["effect.",             EventNamespace.Effect],
  ["snapshot.",           EventNamespace.Effect],
  ["rollback.",           EventNamespace.Rollback],
  ["message.",            EventNamespace.Message],
  ["conversation.",       EventNamespace.Conversation],
]

export function getEventNamespace(t: EventType): EventNamespace {
  for (const [prefix, ns] of NAMESPACE_PREFIX) {
    if ((t as string).startsWith(prefix)) return ns
  }
  return EventNamespace.System
}

// ── Lifecycle classification ─────────────────────────────────────

const COMPLETION_EVENTS: ReadonlySet<EventType> = new Set([
  EventType.RunCompleted,
  EventType.AgentCompleted,
  EventType.StepCompleted,
  EventType.ToolCompleted,
  EventType.ToolCallCompleted,
  EventType.DelegationCompleted,
  EventType.PlannerCompleted,
  EventType.PlannerStepCompleted,
  EventType.SyncPreviewCompleted,
  EventType.SyncExecuteCompleted,
  EventType.SyncAgentExecuteCompleted,
  EventType.RollbackCompleted,
])

const FAILURE_EVENTS: ReadonlySet<EventType> = new Set([
  EventType.RunFailed,
  EventType.RunUserSafeFailure,
  EventType.AgentFailed,
  EventType.AgentUserSafeFailure,
  EventType.StepFailed,
  EventType.ToolFailed,
  EventType.DelegationFailed,
  EventType.PlannerFailed,
  EventType.PlannerCoherentFailed,
  EventType.PlannerValidationFailed,
  EventType.SyncPreviewFailed,
  EventType.SyncPreviewTableFailed,
  EventType.SyncExecuteFailed,
  EventType.SyncExecuteStepFailed,
  EventType.MessageFailed,
  EventType.ProceduralFailed,
])

const CANCELLATION_EVENTS: ReadonlySet<EventType> = new Set([
  EventType.RunCancelled,
  EventType.AgentCancelled,
])

const SUB_STEP_FAILURE_EVENTS: ReadonlySet<EventType> = new Set([
  EventType.SyncExecuteStepFailed,
  EventType.SyncPreviewTableFailed,
])

export function isCompletionEvent(t: EventType): boolean {
  return COMPLETION_EVENTS.has(t)
}

export function isFailureEvent(t: EventType): boolean {
  return FAILURE_EVENTS.has(t)
}

export function isCancellationEvent(t: EventType): boolean {
  return CANCELLATION_EVENTS.has(t)
}

export function isSubStepFailureEvent(t: EventType): boolean {
  return SUB_STEP_FAILURE_EVENTS.has(t)
}

export function isTerminalRunEvent(t: EventType): boolean {
  return (
    t === EventType.RunCompleted ||
    t === EventType.RunFailed ||
    t === EventType.RunCancelled ||
    t === EventType.RunUserSafeFailure
  )
}

export function isStepEvent(t: EventType): boolean {
  return getEventNamespace(t) === EventNamespace.Step ||
         getEventNamespace(t) === EventNamespace.ToolCall
}

export function isSyncEvent(t: EventType): boolean {
  const ns = getEventNamespace(t)
  return ns === EventNamespace.Sync || ns === EventNamespace.SyncEnv
}
