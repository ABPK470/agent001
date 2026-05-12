import type { EngineServices, LLMClient } from "@agent001/agent"
import type { AgentBus } from "../agent-bus.js"
import type { MessageRouter } from "../channels/router.js"
import type { RunQueue } from "../queue.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../run-workspace.js"
export type { RunPriority } from "../queue.js"

// ── Run-level state ───────────────────────────────────────────────

export interface ActiveRun {
  id: string
  goal: string
  agentId: string | null
  controller: AbortController
  services: EngineServices
  traceSeq: number
  bus: AgentBus
  workspace: RunWorkspaceContext | null
}

// ── Public API types ──────────────────────────────────────────────

/** Per-run agent configuration — which tools and prompt to use. */
export interface AgentRunConfig {
  agentId?: string
  tools?: import("@agent001/agent").Tool[]
  systemPrompt?: string
}

export interface OrchestratorConfig {
  llm: LLMClient
  messageRouter?: MessageRouter
  workspace?: string
}

// ── Notification types ────────────────────────────────────────────

export interface NotificationOpts {
  type: string
  title: string
  message: string
  runId?: string | null
  stepId?: string | null
  actions?: Array<{ label: string; action: string; data?: Record<string, unknown> }>
}

// ── Context passed from orchestrator → executeRunImpl ────────────

/**
 * All orchestrator state needed to execute a run.
 * Passed by reference — mutations inside executeRunImpl are visible to the caller.
 */
export interface OrchestratorRunCtx {
  llm: LLMClient
  workspace: string | null
  queue: RunQueue
  activeRuns: Map<string, ActiveRun>
  pendingInputs: Map<string, { resolve: (answer: string) => void }>
  pendingKills: Map<string, { resolve: (message: string) => void; perToolCtrl: AbortController }>
  completedRunWorkspaces: Map<string, RunWorkspaceContext>
  completedRunDiffs: Map<string, WorkspaceDiff>
  messageRouter: MessageRouter | null
}
