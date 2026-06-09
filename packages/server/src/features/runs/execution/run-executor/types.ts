import {
  type Agent,
  type AgentHost,
  type DelegateContext,
  type EngineServices,
  type ExecutableTool,
  type HostedPolicyContext,
  type Message,
  type RunState,
  type Tool,
  type Unsubscribe
} from "@mia/agent"
import { type prepareRunWorkspace } from "../../../../bootstrap/workspace.js"
import type { AgentBus } from "../../../../platform/queue/agent-bus.js"
import { type RunPriority } from "../../../../platform/queue/run-queue.js"
import type { OrchestratorRunCtx } from "../../../../ports/orchestration.js"

export type RunWorkspace = Awaited<ReturnType<typeof prepareRunWorkspace>>

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

export type ExecuteRunRuntimeDeps = {
  orchestrator: OrchestratorRunCtx
  controller: AbortController
  bus: AgentBus
}

export type ExecuteRunSideEffectServices = {
  engine: EngineServices
}

export type ExecuteRunCommand = {
  request: ExecuteRunRequestDto
  runtime: ExecuteRunRuntimeDeps
  sideEffects: ExecuteRunSideEffectServices
}

export type ActiveRunRecord =
  OrchestratorRunCtx["activeRuns"] extends Map<string, infer TValue> ? TValue : never

export type AgentRef = {
  current: Agent | null
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
  agentRef: AgentRef
}

export type ToolResolution = {
  governedTools: Tool[]
  perTier: { working: string; episodic: string; semantic: string }
  toolDecision: ReturnType<typeof import("../../core/decide-sections.js").decideSections>
}

export type ToolResolutionContext = {
  command: ExecuteRunCommand
  activeRun: ActiveRunRecord | undefined
  runWorkspace: RunWorkspace
  state: RunState
  policyCtx: HostedPolicyContext
  tracing: ExecutionTraceBundle
}

export type DelegateRuntimeContext = {
  command: ExecuteRunCommand
  activeRun: ActiveRunRecord | undefined
  state: RunState
  runContext: ReturnType<typeof import("@mia/agent").makeRunContext>
  perRunHost: AgentHost
  agentRef: AgentRef
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
  agentRef: AgentRef
}
