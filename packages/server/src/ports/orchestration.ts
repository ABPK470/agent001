import type { AttachmentService, BrowserClient, BrowserContextProvider, BrowserCredentialProvider, BrowserHandoffProvider, EngineServices, LLMClient, PolicyRole, ShellClient } from "@mia/agent"
import type { AgentBus } from "../agent-bus.js"
import type { RunQueue } from "../application/shell/queue/run-queue.js"
import type { RunWorkspaceContext, WorkspaceDiff } from "../application/shell/workspace/run-workspace.js"
import type { MessageRouterPort } from "./channels.js"
import type { ClarificationsRegistryPort } from "./clarifications.js"
export type { RunPriority } from "../application/shell/queue/run-queue.js"

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
  messageRouter?: MessageRouterPort
  workspace?: string
  /**
   * Boot-time host dependencies (ports captured by the server entrypoint and
   * threaded through to every per-run host built by the orchestrator).
   *
   * The orchestrator NEVER constructs these — it just forwards them into
   * `configureAgent({...})` at run start. This is the explicit-DI replacement
   * for the deleted module-level setBootHostOptions/setActiveAgentHost
   * shortcut. See docs/doctrine.md §1.
   */
  bootHostDeps: BootHostDeps
}

/**
 * Boot-time host dependencies — ports the server resolves once at boot and
 * passes to every per-run host. Each field is optional (the server may not
 * have an attachments backend in tests, for example) and forwarded verbatim
 * to {@link import("@mia/agent").configureAgent}.
 */
export interface BootHostDeps {
  attachments?: AttachmentService | null
  browserContextReader?: BrowserContextProvider | null
  browserCredentialReader?: BrowserCredentialProvider | null
  browserHandoffStore?: BrowserHandoffProvider | null
  /** Sandbox-routed shell client (Docker exec). Null = host execution. */
  shellClient?: ShellClient | null
  /** Sandbox "all" mode — relaxed deny list when true. */
  shellSandboxStrict?: boolean
  /** Sandbox-routed Playwright client. Null = host fallback. */
  browserCheckClient?: BrowserClient | null
  /** Shared mssql connection registry (mutable Map, populated by setupMssql). */
  mssqlDatabases?: import("@mia/agent").AgentHost["mssql"]["databases"]
  /** Shared mssql default-connection ref (mutable container). */
  mssqlDefaultConnection?: import("@mia/agent").AgentHost["mssql"]["defaultConnection"]
  /** Shared catalog registry (mutable Map, populated by buildCatalog at boot). */
  catalogInstances?: import("@mia/agent").AgentHost["catalog"]["instances"]
  /** Shared catalog default-cachePath ref (mutable container). */
  catalogDefaultCachePath?: import("@mia/agent").AgentHost["catalog"]["defaultCachePath"]
  /** Shared sync host state (environments, plans, sinks, registry readers). */
  syncState?: import("@mia/agent").AgentHost["sync"]
  /** Shared toolKnowledge adapter — same instance for boot + per-run hosts. */
  toolKnowledge?: import("@mia/agent").AgentHost["toolKnowledge"]
  /** Shared tableVerdicts adapter — same instance for boot + per-run hosts. */
  tableVerdicts?: import("@mia/agent").AgentHost["tableVerdicts"]
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
  messageRouter: MessageRouterPort | null
  /**
   * Per-run clarification state. The system-messages renderer records
   * emitted findings; askUserResolve matches incoming questions against
   * those findings; respondToRun stores the user's answer as a
   * ResolvedClarification so the next round's detector context can
   * suppress re-asking the same subject.
   */
  clarifications: ClarificationsRegistryPort
  /** Boot deps forwarded into every per-run `configureAgent({...})` call. */
  bootHostDeps: BootHostDeps
}
