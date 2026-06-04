import { type Agent, type DelegateContext, type EngineServices, type Message, type RunState, type Tool, type Unsubscribe } from "@mia/agent"
import type { AgentBus } from "../../../../agent-bus.js"
import type { OrchestratorRunCtx } from "../../../../ports/orchestration.js"
import { type RunPriority } from "../../queue/run-queue.js"
import { type prepareRunWorkspace } from "../../workspace/run-workspace.js"

export type RunWorkspace = Awaited<ReturnType<typeof prepareRunWorkspace>>

export type ResumeState = {
  messages: Message[]
  iteration: number
  parentRunId: string
}

export type ExecuteRunInput = {
  ctx: OrchestratorRunCtx
  runId: string
  goal: string
  tools: Tool[]
  systemPrompt: string | undefined
  agentId: string | null
  services: EngineServices
  controller: AbortController
  bus: AgentBus
  resume?: ResumeState
  priority: RunPriority
}

export type ActiveRunRecord = OrchestratorRunCtx["activeRuns"] extends Map<string, infer TValue> ? TValue : never

export type AgentRef = {
  current: Agent | null
}

export type ProgressState = {
  lastMessages: Message[]
  lastIteration: number
  prevTotalTokens: number
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
  toolDecision: ReturnType<typeof import("../../../core/decide-sections.js").decideSections>
  delegateCtx: DelegateContext
  allTools: Tool[]
  systemMessages: Awaited<ReturnType<typeof import("../../../core/system-messages.js").buildSystemMessages>>
  agentRef: AgentRef
}