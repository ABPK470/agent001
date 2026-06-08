import type {
    AttachmentService,
    BrowserClient,
    BrowserContextProvider,
    BrowserCredentialProvider,
    BrowserHandoffProvider,
    CatalogGraph,
    EngineServices,
    LLMClient,
    MssqlEntry,
    PolicyRole,
    ShellClient,
} from "@mia/agent"
import type { FreezeWindowDefinition, PublishedSyncDefinitionRegistry, SyncEnvironment, SyncEventSink, SyncPlan, SyncRunSink } from "@mia/sync"
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

export interface BootShellDeps {
  mode: "host" | "sandbox" | "disabled"
  client?: ShellClient | null
  sandboxStrict?: boolean
}

export interface BootBrowserCheckDeps {
  mode: "host" | "sandbox" | "disabled"
  client?: BrowserClient | null
}

export interface BootBrowserState {
  providers: {
    contextReader: BrowserContextProvider | null
    credentialReader: BrowserCredentialProvider | null
    handoffStore: BrowserHandoffProvider | null
  }
}

export interface BootMssqlState {
  databases: Map<string, MssqlEntry>
  defaultConnection: { value: string | null }
}

export interface BootCatalogState {
  instances: Map<string, CatalogGraph>
  defaultCachePath: { value: string | undefined }
}

export interface BootSyncState {
  events: { sink: SyncEventSink }
  runs: { sink: SyncRunSink }
  governance: { freezeWindowsReader: () => readonly FreezeWindowDefinition[] }
  environments: { items: Map<string, SyncEnvironment> }
  plans: { diskRoot: string | null; memCache: Map<string, SyncPlan> }
  project: {
    dbProjectRoot: string | null
    publishedDefinitions: PublishedSyncDefinitionRegistry
  }
}

/**
 * Boot-time host dependencies — ports the server resolves once at boot and
 * passes to every per-run host. Each field is optional (the server may not
 * have an attachments backend in tests, for example) and forwarded verbatim
 * to {@link import("@mia/agent").configureAgent}.
 */
export interface BootHostDeps {
  attachments?: AttachmentService | null
  browser?: BootBrowserState
  shell?: BootShellDeps
  browserCheck?: BootBrowserCheckDeps
  mssql?: BootMssqlState
  catalog?: BootCatalogState
  sync?: BootSyncState
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
