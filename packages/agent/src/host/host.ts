/**
 * host/host.ts — AgentHost + RunContext.
 *
 * The doctrine, in two type declarations:
 *
 *   AgentHost   — every adapter the agent needs, wired once at boot.
 *                 Lives for the whole process. Pass it down by argument.
 *
 *   RunContext  — everything that changes between runs (signal, trace,
 *                 per-run memory writer, sync op context). Threaded as
 *                 a parameter to tool handlers. Never module-global.
 *
 * Nothing here is a class. Nothing here is mutable. The host record is
 * built once by `configureAgent()` and never re-bound. The run context
 * is built once per `runAgent()` call and never re-bound. Both are
 * plain readonly records.
 *
 * Existing `AgentRuntime` and `currentRuntime()` keep working unchanged
 * while Phase 4 migrates each cluster to read these types instead.
 */

import type { SyncEnvironment, SyncEventSink, SyncPlan, SyncRecipeBundle, SyncRunSink } from "../sync/index.js"
import type { BrowserSession, CatalogGraph } from "../tools/index.js"
import type {
    AttachmentStore,
    BrowserClient,
    BrowserContextReader,
    CredentialReader,
    HandoffStore,
    MssqlEntry,
    RecipeReader,
    ShellClient,
    TableVerdictsReader,
    ToolKnowledgeStore,
    UserInputReader,
} from "./ports.js"

// ── AgentHost — wired once at boot ───────────────────────────────

export interface MssqlHost {
  /** Connection registry — read-only after boot. */
  readonly databases: ReadonlyMap<string, MssqlEntry>
  /** Override which named connection serves `connection: "default"`. */
  readonly defaultConnection: string | null
}

export interface FilesystemHost {
  /** Sandbox root — all file paths must resolve under this. */
  readonly basePath: string
}

export interface SearchFilesHost {
  readonly basePath: string
  readonly excludeDirs: ReadonlySet<string>
}

export interface ShellHost {
  readonly cwd: string
  readonly sandboxStrict: boolean
  readonly client: ShellClient
}

export interface BrowserCheckHost {
  readonly cwd: string
  readonly client: BrowserClient | null
}

export interface BrowserHost {
  /** Process-wide live browser sessions. Tools mutate this map. */
  readonly sessions: Map<string, BrowserSession>
  readonly contextReader: BrowserContextReader | null
  readonly credentialReader: CredentialReader | null
  readonly handoffStore: HandoffStore | null
}

export interface CatalogHost {
  /** Per-connection catalog graphs — expensive caches. */
  readonly instances: Map<string, CatalogGraph>
  readonly defaultCachePath: string | undefined
}

export interface SyncHost {
  readonly events: SyncEventSink
  readonly runSink: SyncRunSink
  readonly recipes: { bundle: SyncRecipeBundle | null; loadedFromPath: string | null }
  readonly environments: ReadonlyMap<string, SyncEnvironment>
  readonly recipeReader: RecipeReader | null
  /** Plan disk root + in-memory cache (the cache is mutated; root is fixed). */
  readonly plans: { readonly diskRoot: string | null; readonly memCache: Map<string, SyncPlan> }
  readonly dbProjectRoot: string | null
}

export interface TenantHost {
  readonly id: string | null
  readonly displayName: string | null
  readonly featureFlags: ReadonlyMap<string, boolean>
}

/**
 * Everything the agent needs from the world, in one record.
 *
 * Built once by {@link configureAgent} at process startup. Passed by
 * argument from the entrypoint down to whatever needs it. Never stored
 * in a module global, never accessed through a thread-local lookup.
 *
 * A field being `null` is a deliberate signal: that capability is not
 * wired in this deployment (CLI / tests / a server without browser
 * support). Tools that depend on it must surface a friendly error.
 */
export interface AgentHost {
  readonly workspaceRoot: string
  readonly mssql: MssqlHost
  readonly filesystem: FilesystemHost
  readonly searchFiles: SearchFilesHost
  readonly shell: ShellHost
  readonly browserCheck: BrowserCheckHost
  readonly browser: BrowserHost
  readonly userInput: UserInputReader | null
  readonly attachments: AttachmentStore | null
  readonly toolKnowledge: ToolKnowledgeStore | null
  readonly tableVerdicts: TableVerdictsReader | null
  readonly catalog: CatalogHost
  readonly sync: SyncHost
  readonly tenant: TenantHost
}

// ── RunContext — built per run, passed as a parameter ────────────

/**
 * Per-run memory writer. The server binds a concrete implementation per
 * agent run so durable lessons (validator auto-notes, tool-execution
 * findings) route to `ingestAgentNote`. Null when the agent runs without
 * a server (CLI / tests) — lessons are dropped, the doctrine block fires
 * unchanged.
 */
export interface RunMemoryWriter {
  writeNote(payload: {
    subject: string
    claim: string
    evidence?: string
    category?: string
  }): void
}

/** Causal trace for a tool call — opaque to most callers. */
export interface ToolTraceContext {
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly parentCallId: string | null
}

/**
 * Policy-decision context for governance hooks (current step, current
 * delegation depth, etc.). Read-only.
 */
export interface PolicyContext {
  readonly runId: string
  readonly currentStep: string | null
  readonly delegationDepth: number
}

/** Context for an in-flight sync operation (which plan, which entity). */
export interface SyncOpContext {
  readonly planId: string
  readonly entityType: string | null
  readonly environment: string | null
}

/**
 * Everything that varies between agent runs.
 *
 * Built once by `runAgent({ ... })` at run start, threaded to every tool
 * handler as a parameter. No `AsyncLocalStorage`, no setters. When a tool
 * needs a per-run value it accepts a `RunContext` argument.
 */
export interface RunContext {
  /** Per-run abort signal. Tools should pass this to long IO. */
  readonly signal: AbortSignal | null
  /** Per-run memory writer; null when no server is bound. */
  readonly memory: RunMemoryWriter | null
  /** Active tool-call trace, if inside a tool handler. */
  readonly trace: ToolTraceContext | null
  /** Active policy context, if a policy decision is being made. */
  readonly policy: PolicyContext | null
  /** Active sync-op context, if executing a sync runbook step. */
  readonly syncOp: SyncOpContext | null
  /**
   * Per-run set of qualified table names that `profile_data` has been
   * called on. Read by the MSSQL validator to soft-warn on big-view
   * queries with no preceding profile. Mutated by `profile_data`.
   */
  readonly mssqlProfileCalls: Set<string>
}
