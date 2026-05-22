import type { EngineServices, LLMClient, PolicyRole } from "@mia/agent"
import type { AgentBus } from "../agent-bus.js"
import type { MessageRouter } from "../channels/router.js"
import type { RunQueue } from "../queue.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../run-workspace.js"
import type { ClarificationsRegistry } from "./clarifications-state.js"
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
  /**
   * Role used by the policy engine for selector evaluation. Captured at
   * startRun/resumeRun from the originating session because by the time
   * the queued executor runs the session ALS may already be empty.
   */
  role: PolicyRole
  /** Attachment IDs supplied at run-start time. Empty array when none. */
  attachmentIds: string[]
  /**
   * UPN of the user who started the run, captured at startRun/resumeRun.
   * Null for unauthenticated/admin invocations. Used by the agent-side
   * attachment service to bind ownership of promoted artifacts so the
   * originating user can later see them.
   */
  ownerUpn: string | null
  /** Originating session id (cookie sid). Null for service-internal runs. */
  sessionId: string | null
}

// ── Public API types ──────────────────────────────────────────────

/** Per-run agent configuration — which tools and prompt to use. */
export interface AgentRunConfig {
  agentId?: string
  tools?: import("@mia/agent").Tool[]
  systemPrompt?: string
  /**
   * Attachments selected by the user when this run was started.
   * Captured at startRun and surfaced in the system prompt so the agent
   * knows what it can pull into the sandbox via the attachment tools.
   */
  attachmentIds?: string[]
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
  /**
   * Per-run clarification state. The system-messages renderer records
   * emitted findings; askUserResolve matches incoming questions against
   * those findings; respondToRun stores the user's answer as a
   * ResolvedClarification so the next round's detector context can
   * suppress re-asking the same subject.
   */
  clarifications: ClarificationsRegistry
}
