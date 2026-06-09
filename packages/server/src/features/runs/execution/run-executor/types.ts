import {
  type AgentHost,
  type AuditService,
  type DelegateContext,
  type EngineServices,
  type ExecutableTool,
  type HostedPolicyContext,
  type LLMClient,
  type Message,
  type RunState,
  type Tool,
  type Unsubscribe
} from "@mia/agent"
import { type WorkspaceDiff, type prepareRunWorkspace } from "../../../../bootstrap/workspace.js"
import type { AgentBus } from "../../../../platform/queue/agent-bus.js"
import { type RunPriority } from "../../../../platform/queue/run-queue.js"
import type { ClarificationsRegistryPort } from "../../../../ports/clarifications.js"
import type { ActiveRun, BootHostDeps, NotificationOpts } from "../../../../ports/orchestration.js"

export type RunWorkspace = Awaited<ReturnType<typeof prepareRunWorkspace>>
export type ActiveRunRecord = ActiveRun

export type ResumeState = {
  messages: Message[]
  iteration: number
  parentRunId: string
}

export type ExecuteRunRequestDto = {
  runId: string
  goal: string
  tools: ExecutableTool[]
  systemPrompt: string | undefined
  agentId: string | null
  resume?: ResumeState
  priority: RunPriority
}

export interface RunQueuePort {
  acquire(runId: string, priority: RunPriority, signal: AbortSignal): Promise<() => void>
}

export interface RunInteractionPort {
  llm: LLMClient
  clarifications: ClarificationsRegistryPort
  registerPendingInput(runId: string, pending: { resolve: (answer: string) => void }): void
  clearPendingInput(runId: string): void
  registerPendingKill(
    key: string,
    pending: { resolve: (message: string) => void; perToolCtrl: AbortController }
  ): void
  clearPendingKill(key: string): void
}

export interface RunRegistryPort {
  getActiveRun(runId: string): ActiveRunRecord | undefined
  assignWorkspace(runId: string, workspace: RunWorkspace): void
  appendTrace(runId: string, entry: Record<string, unknown>): void
  removeActiveRun(runId: string): void
}

export interface RunWorkspaceStorePort {
  captureOutputDiff(
    runId: string,
    saveTrace: (runId: string, entry: Record<string, unknown>) => void,
    createNotification: (opts: NotificationOpts) => void
  ): Promise<void>
  getCompletedDiff(runId: string): WorkspaceDiff | null
}

export interface RunMessagingPort {
  publish(message: Parameters<AgentBus["publish"]>[0]): ReturnType<AgentBus["publish"]>
  history(): ReturnType<AgentBus["history"]>
  createChildTools(childRunId: string, childAgentName: string): ExecutableTool[]
  sendReply(runId: string, answer: string): Promise<void>
  dispose(): void
}

export type ExecuteRunRuntimeDeps = {
  workspaceRoot: string | null
  queue: RunQueuePort
  interaction: RunInteractionPort
  registry: RunRegistryPort
  workspaceStore: RunWorkspaceStorePort
  messaging: RunMessagingPort
  bootHostDeps: BootHostDeps
  controller: AbortController
}

export type RunRepoPort = EngineServices["runRepo"]
export type AuditLogPort = AuditService
export type EventBusPort = EngineServices["eventBus"]
export type PolicyEvaluatorPort = EngineServices["policyEvaluator"]
export type LearnerPort = EngineServices["learner"]

export interface NotificationPort {
  notify(opts: NotificationOpts): void
}

export type ExecuteRunSideEffectServices = {
  runRepo: RunRepoPort
  auditLog: AuditLogPort
  eventBus: EventBusPort
  policyEvaluator: PolicyEvaluatorPort
  learner: LearnerPort
  notifications: NotificationPort
}

export type ExecuteRunCommand = {
  request: ExecuteRunRequestDto
  runtime: ExecuteRunRuntimeDeps
  sideEffects: ExecuteRunSideEffectServices
}

export type ProgressState = {
  lastMessages: Message[]
  lastIteration: number
  prevTotalTokens: number
}

export type WorkspacePreparation = {
  activeRun: ActiveRunRecord | undefined
  runWorkspace: RunWorkspace
}

export type ExecutionStateBundle = {
  actor: string
  progress: ProgressState
  state: RunState
}

export type RunPersistenceBundle = {
  boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
  persistCurrentRun: (answer?: string, error?: string) => void
  markRunStarted: () => Promise<void>
  initialize: () => Promise<void>
}

export type ExecutionTraceBundle = {
  boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
  debugSeqRef: { value: number }
}

export type PerRunHostBundle = {
  runContext: ReturnType<typeof import("@mia/agent").makeRunContext>
  perRunHost: AgentHost
  policyCtx: HostedPolicyContext
  debugSeqRef: { value: number }
}

export type ToolResolution = {
  governedTools: Tool[]
  perTier: { working: string; episodic: string; semantic: string }
  toolDecision: ReturnType<typeof import("../../core/decide-sections.js").decideSections>
}

export type ToolResolutionContext = {
  request: ExecuteRunRequestDto
  signal: AbortSignal
  activeRun: ActiveRunRecord | undefined
  runWorkspace: RunWorkspace
  state: RunState
  policyCtx: HostedPolicyContext
  services: ExecuteRunSideEffectServices
  tracing: ExecutionTraceBundle
}

export type DelegateRuntimeContext = {
  request: ExecuteRunRequestDto
  signal: AbortSignal
  activeRun: ActiveRunRecord | undefined
  state: RunState
  runContext: ReturnType<typeof import("@mia/agent").makeRunContext>
  perRunHost: AgentHost
  reportChildUsage: NonNullable<DelegateContext["onChildUsage"]>
  llm: LLMClient
  queue: RunQueuePort
  interaction: RunInteractionPort
  messaging: RunMessagingPort
  services: ExecuteRunSideEffectServices
  tracing: Pick<ExecutionTraceBundle, "boundSaveTrace">
}

export type DelegateToolsBundle = {
  allTools: ExecutableTool[]
  delegateCtx: DelegateContext
}

export type ExecutionSystemMessagesBundle = {
  effectivePrompt: string
  systemMessages: Awaited<ReturnType<typeof import("../../core/system-messages.js").buildSystemMessages>>
}

export type ExecutionEnvironment = {
  actor: string
  activeRun: ActiveRunRecord | undefined
  runWorkspace: RunWorkspace
  state: RunState
  progress: ProgressState
  debugSeqRef: { value: number }
  boundSaveTrace: (runId: string, entry: Record<string, unknown>) => void
  persistCurrentRun: (answer?: string, error?: string) => void
  markRunStarted: () => Promise<void>
  disposeEventWiring: Unsubscribe
  runContext: ReturnType<typeof import("@mia/agent").makeRunContext>
  toolDecision: ReturnType<typeof import("../../core/decide-sections.js").decideSections>
  delegateCtx: DelegateContext
  allTools: ExecutableTool[]
  systemMessages: Awaited<ReturnType<typeof import("../../core/system-messages.js").buildSystemMessages>>
}
