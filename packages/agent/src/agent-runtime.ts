/**
 * AgentRuntime — the per-agent container for state
 *
 * Two tiers of state
 * ------------------
 * Now that multiple runtimes can be alive at once (one per HTTP request,
 * plus one per delegated child agent), we need to say which slots are
 * shared across runtimes and which are owned by a single runtime:
 *
 *   - **Tier 1 — process-wide infrastructure**, shared by reference from
 *     parent → child: mssql connection pools (expensive, multiplexable),
 *     shell/browser-check executors (boot singletons), the catalog cache
 *     (expensive to rebuild), the sync sinks the server installs at boot,
 *     and the browse-web cleanup timer.
 *   - **Tier 2 — per-runtime / per-request**, fresh in every runtime:
 *     workspace cwd / basePath / signal, per-tool-call kill signals
 *     (shell/fetch/browse-web), browse-web sessions (so each agent owns
 *     its own browser tabs), and the ask-user resolver (each chat session
 *     has its own UI socket).
 *
 * Construct an `AgentRuntime` with no parent (`isRoot: true`) and you get
 * the **root**: blank slates everywhere, configured by the server at boot.
 * Construct one with a parent — the default is the process root — and the
 * tier-1 slots are shared by reference while tier-2 slots start fresh.
 *
 * Looking up the runtime from inside a tool
 * -----------------------------------------
 * Tools call {@link currentRuntime} (no arguments). The active runtime is
 * resolved through Node's `AsyncLocalStorage`:
 *
 *   1. If the caller is inside an `AgentRuntime#run(...)` scope, that scope's
 *      runtime is returned. The Agent loop wraps every `agent.run()` call in
 *      `this.runtime.run(...)`, so all tool invocations during a run see the
 *      Agent's own runtime.
 *   2. Otherwise (server startup, CLI bootstrap, tests that haven't
 *      installed a scope), {@link AgentRuntime.root} is returned.
 *
 * Configuring the runtime from server / CLI
 * -----------------------------------------
 * The setter functions exported by individual tool/sync files
 * (`setShellCwd`, `setMssqlConfig`, `setSyncEventSink`, …) are kept as
 * thin wrappers that mutate `currentRuntime()`. Calling them from server
 * startup mutates the root runtime (the one Agents will later inherit
 * shared slots from).
 *
 * Disposal
 * --------
 * `AgentRuntime#dispose()` always closes the calling runtime's own browse
 * sessions. The root runtime additionally closes mssql pools and the
 * browse-web cleanup timer (which it owns process-wide).
 */

import type sql from "mssql"
import { AsyncLocalStorage } from "node:async_hooks"
import { HumanHandoffReason, UserInputStatus } from "./domain/enums/agent-runtime.js"
import { AttachmentScope } from "./domain/enums/attachment.js"
import { IngestionMode } from "./domain/enums/runtime.js"

// ── Type-only forward declarations ────────────────────────────────
// These imports are erased at runtime, so there is no circular dependency
// between this file and the tool/sync files that call `currentRuntime()`.
// Sourced via cluster barrels to satisfy the cluster-door lint.
import type {
  SyncEnvironment,
  SyncEventSink,
  SyncPlan,
  SyncRecipeBundle,
  SyncRunSink,
} from "./sync/index.js"
import type {
  BrowserCheckExecutor,
  BrowserSession,
  CatalogGraph,
  ShellExecutor,
} from "./tools/index.js"

// ── Sub-state shapes ──────────────────────────────────────────────

export interface MssqlEntry {
  config: sql.config
  pool: sql.ConnectionPool | null
  writeEnabled: boolean
  knowledge: string | null
}

export interface MssqlState {
  /** Process-wide pool registry — shared with parent runtime. */
  databases: Map<string, MssqlEntry>
  /** Override which named connection serves `connection: "default"`. */
  defaultConnection: string | null
  /**
   * Per-run set of schema-qualified table names that the agent has called
   * `profile_data` on. Used by the validator to soft-warn when a query
   * touches a known-big view without a preceding profile call (Phase 3).
   * Lowercased schema.table; never shared with parent (sub-agents have
   * their own discipline).
   */
  profileDataCalled: Set<string>
}

export interface BrowseWebState {
  /** Per-runtime browser sessions — disposed when the runtime is disposed. */
  sessions: Map<string, BrowserSession>
  counter: number
  /** Per-tool-call kill signal — closes the active page when aborted. */
  killSignal: AbortSignal | null
  /** Process-wide idle-session evictor — owned by the root runtime. */
  cleanupTimer: NodeJS.Timeout | null
  /** Persistent context provider installed by the host (server). Null in CLI/tests → ephemeral sessions. */
  contextProvider: BrowserContextProvider | null
  /** Credential resolver installed by the host (server). Null in CLI/tests → auto-login refused. */
  credentialProvider: BrowserCredentialProvider | null
  /** Visible-browser handoff provider installed by the host. Null in CLI/tests → human handoff refused. */
  handoffProvider: BrowserHandoffProvider | null
}

/**
 * Persistent browser-context provider — installed by the server at boot
 * via {@link setBrowserContextProvider}. Returns null for anonymous sessions
 * (no upn) or when no provider is configured (CLI / tests).
 */
export interface BrowserContextProvider {
  acquire(): Promise<BrowserContextHandle | null>
}

export interface BrowserContextHandle {
  /** Stable seed for fingerprint selection (typically the upn). */
  fingerprintSeed: string
  /** Pass directly to Playwright `browser.newContext({ storageState })`. */
  storageState: unknown | null
  /**
   * Optional BYO upstream proxy for this tenant. Plumbed straight into
   * Playwright's `chromium.launch({ proxy })`. Null = direct connection.
   * Hosts MUST never resolve a proxy for anonymous sessions.
   */
  proxy?: { server: string; bypass?: string; username?: string; password?: string } | null
  /**
   * Optional compliance guard. When present the agent calls
   * `guard.checkUrl(url)` immediately before navigation and refuses to
   * proceed if `allow === false`. The agent also records each successful
   * action via `guard.recordAction(...)` so the host can append to the
   * audit log.
   */
  guard?: BrowserGuard | null
  /** Persist the latest storage state. Caller invokes after meaningful changes. */
  save(state: unknown): Promise<void>
}

/**
 * Compliance hooks installed by the host alongside the persistent
 * context. The agent treats `null` as a permissive default — only the
 * server actually enforces policy / rate limits / auditing.
 */
export interface BrowserGuard {
  /**
   * Approve (or deny) a navigation. The host should also consume the
   * tenant's per-domain token bucket here so rate limits are enforced
   * even for tools that don't call `recordAction` afterwards.
   */
  checkUrl(url: string): Promise<{ allow: boolean; reason: string; retryAfterMs?: number }>
  /** Record a successful action for auditing. Best-effort; never throws. */
  recordAction(input: { action: string; url?: string; detail?: string }): Promise<void>
}

/**
 * Credential resolver — installed by the host (server) at boot. Resolves
 * a credential id against the active tenant (per AsyncLocalStorage).
 * Returns null for cross-tenant lookups, missing rows, or anonymous
 * sessions, so the agent surfaces a friendly "not found" without leaking
 * existence info.
 *
 * For TOTP credentials the host computes the live 6-digit code so the
 * agent never sees the raw shared secret.
 */
export interface BrowserCredentialProvider {
  resolvePassword(id: string): Promise<{ label: string; targetOrigin: string; username: string; password: string } | null>
  resolveTotp(id: string): Promise<{ label: string; targetOrigin: string; code: string } | null>
}

/**
 * Visible-browser handoff provider. Installed by the host so the agent
 * can mint a noVNC URL and wait for the user to complete a CAPTCHA /
 * non-TOTP 2FA challenge inside the live sandbox session.
 *
 * Returns null for anonymous sessions or when no provider is wired —
 * the agent should then fail loudly rather than silently skip the human
 * step.
 */
export interface BrowserHandoffProvider {
  request(input: {
    browserSessionId: string
    reason: HumanHandoffReason
    ttlMs?: number
  }): Promise<{ id: string; url: string; expiresAt: number } | null>
  await(id: string): Promise<{ status: UserInputStatus }>
}

export interface ShellState {
  cwd: string
  /** Process-wide shell executor (e.g. Docker sandbox). */
  executor: ShellExecutor | null
  sandboxStrict: boolean
  killSignal: AbortSignal | null
}

export interface BrowserCheckState {
  cwd: string
  executor: BrowserCheckExecutor | null
}

export interface FetchUrlState {
  killSignal: AbortSignal | null
}

export interface FilesystemState {
  basePath: string
}

export interface SearchFilesState {
  basePath: string
  /** Boot-config — shared across runtimes. */
  excludeDirs: Set<string>
}

/**
 * Per-run memory writer hook (Gap 2). The server binds this at run start so
 * agent-side code (validator-driven auto-notes, tool-execution lessons) can
 * route durable memory writes to ingestAgentNote without depending on the
 * server package. When `writeNote` is null (root runtime, tests, CLI) the
 * lesson is silently dropped — the doctrine block still fires.
 */
export interface MemoryState {
  writeNote: ((payload: {
    subject: string
    claim: string
    evidence?: string
    category?: string
  }) => void) | null
}

/**
 * Per-run org-wide knowledge cache for heavy MSSQL-tool outputs. The server
 * binds these at run start; when null (root runtime, tests, CLI) tools fall
 * straight through to live execution. See
 * /memories/repo/tool-knowledge-cache.md.
 *
 * Fingerprint shape is opaque to the agent — it's just whatever the server's
 * fingerprintFromCatalogTable returns and compares.
 */
export type ToolKnowledgeCachedTool = "profile_data" | "inspect_definition" | "discover_relationships" | "explore_mssql_schema"

export interface ToolKnowledgeFingerprint {
  cols: number
  type: "T" | "V"
  csum: string
}

export interface ToolKnowledgeLookupArgs {
  tool: ToolKnowledgeCachedTool
  qname: string
  mode?: string
  connection?: string
  currentFingerprint: ToolKnowledgeFingerprint | null
}

export interface ToolKnowledgeHit {
  hit: true
  payload: string
  ageMs: number
  profiledAt: number
}

export interface ToolKnowledgeMiss {
  hit: false
  reason: "miss" | "stale" | "fingerprint"
}

export interface ToolKnowledgeSaveArgs {
  tool: ToolKnowledgeCachedTool
  qname: string
  mode?: string
  connection?: string
  payload: string
  fingerprint: ToolKnowledgeFingerprint
}

export interface ToolKnowledgeState {
  lookup: ((args: ToolKnowledgeLookupArgs) => ToolKnowledgeHit | ToolKnowledgeMiss) | null
  save: ((args: ToolKnowledgeSaveArgs) => void) | null
  /** Render the standard [cached from ...] header given a hit. */
  renderHeader: ((hit: ToolKnowledgeHit, opts: { tool: ToolKnowledgeCachedTool; mode?: string }) => string) | null
}

// ── Table verdicts (Plan v3 Phase 3-4) ───────────────────────────
//
// Verdicts are durable role classifications for MSSQL objects
// ("publish.Revenue is canonical", "publish.RevenueESGRules is a subset"),
// stored in the server's semantic memory tier. The agent's `search_catalog`
// scorer reads them at rank time so prior runs' learnings influence
// current ranking — closing the read-back loop in Gap 2.
//
// The runtime exposes a callback rather than a direct memory import so
// the agent package stays free of server dependencies (matches the
// `toolKnowledge` pattern above). The server binds `list` in
// `run-executor.ts`; CLI / root path leaves it null so search_catalog
// transparently falls back to structural-only ranking.

export type TableVerdictRoleType =
  | "canonical" | "subset" | "staging" | "archive" | "rules" | "unknown"

export interface TableVerdictRecord {
  qname: string
  role: TableVerdictRoleType
  evidence: string[]
  confidence: number
  createdAt: string
}

export interface TableVerdictsListArgs {
  /** Restrict to these qualified names (case-insensitive). */
  qnames: string[]
  /** Logical MSSQL connection to scope to. Defaults to "default". */
  connection?: string
}

export interface TableVerdictsState {
  /** Returns the newest verdict per qname for the given filter. */
  list: ((args: TableVerdictsListArgs) => TableVerdictRecord[]) | null
}

export interface CatalogState {
  /** Expensive caches — shared across runtimes. */
  instances: Map<string, CatalogGraph>
  defaultCachePath: string | undefined
}

export interface SyncState {
  eventSink: SyncEventSink
  runSink: SyncRunSink
  recipes: { bundle: SyncRecipeBundle | null; loadedFromPath: string | null }
  environments: Map<string, SyncEnvironment>
  plans: { diskRoot: string | null; memCache: Map<string, SyncPlan> }
  /** Project root used to resolve relative paths in sync orchestrator helpers. */
  dbProjectRoot: string | null
}

// ── Attachments ──────────────────────────────────────────────────

/**
 * Metadata returned by the attachment service to the agent. Mirrors the
 * server-side public projection but stays decoupled — the agent never
 * imports server types.
 */
export interface AttachmentMetadata {
  id:             string
  scope:          AttachmentScope
  originalName:   string
  normalizedName: string
  mediaType:      string
  sizeBytes:      number
  contentHash:    string
  ingestionMode:  IngestionMode
  uploadedAt:     string
  purposeTag:     string | null
}

/**
 * Service the agent calls to interact with user-uploaded attachments.
 * The server installs a concrete implementation at boot via
 * {@link setAttachmentService}. When no service is installed (CLI / tests)
 * tools surface a friendly "attachments are not configured" error.
 */
export interface AttachmentService {
  list(filter?: { runId?: string; scope?: AttachmentMetadata["scope"]; q?: string }): Promise<AttachmentMetadata[]>
  get(id: string): Promise<AttachmentMetadata | null>
  /**
   * Read the attachment payload. For text-mode attachments returns the
   * decoded UTF-8 text; for binary-mode the raw bytes (caller decides
   * what to do). Implementations should bound the payload size.
   *
   * `offset` lets the agent page through large attachments without
   * re-shipping the leading bytes; `nextOffset` in the result is the
   * byte offset to pass on the next call (or null when EOF).
   */
  read(id: string, opts?: { maxBytes?: number; offset?: number }): Promise<{ kind: "text" | "binary"; text?: string; bytes?: Uint8Array; truncated: boolean; sizeBytes: number; offset: number; nextOffset: number | null }>
  /**
   * Copy the attachment bytes into the active sandbox at the given
   * relative path. Returns the absolute resolved path inside the sandbox.
   * Implementations MUST refuse paths that escape the sandbox.
   */
  importToSandbox(id: string, sandboxRelPath: string): Promise<{ sandboxPath: string; sizeBytes: number }>
  /**
   * Promote a file the agent produced inside the active sandbox into the
   * durable attachment store. Returns the new attachment metadata. The
   * implementation tags the resulting attachment with `source="generated"`
   * so it is distinguishable from user uploads, and binds it to the run
   * that produced it.
   */
  promoteFromSandbox(sandboxRelPath: string, opts?: { mediaType?: string; purposeTag?: string | null }): Promise<AttachmentMetadata>
}

// ── Defaults ──────────────────────────────────────────────────────

const NOOP_RUN_SINK: SyncRunSink = {
  async start() { /* noop */ },
  async finish() { /* noop */ },
}

// ── AgentRuntime ──────────────────────────────────────────────────

export class AgentRuntime {
  /**
   * Workspace root the agent operates in. Tools that need a workspace path
   * should read this rather than calling `process.cwd()` themselves.
   */
  workspaceRoot: string

  /**
   * Per-run abort signal. When set and aborted, in-flight tool calls cancel.
   * The agent loop sets this from `AgentConfig.signal`.
   */
  signal: AbortSignal | null = null

  // State slots — initialised in the constructor (depend on parent).
  readonly mssql: MssqlState
  readonly browseWeb: BrowseWebState
  readonly shell: ShellState
  readonly browserCheck: BrowserCheckState
  readonly fetchUrl: FetchUrlState
  readonly filesystem: FilesystemState
  readonly searchFiles: SearchFilesState
  /** Per-run memory writer hook (Gap 2). Null until the server binds it. */
  readonly memory: MemoryState
  /** Org-wide cache of heavy MSSQL-tool outputs. Null until server binds. */
  readonly toolKnowledge: ToolKnowledgeState
  /**
   * Per-run reader for durable table verdicts (semantic memory). Null
   * until the server binds it. Read by search_catalog to apply
   * memoryVerdictBonus at rank time. See /memories/session/plan.md Phase 4.
   */
  readonly tableVerdicts: TableVerdictsState
  /** Shared with parent (caches are expensive — never duplicated). */
  readonly catalog: CatalogState
  /** Shared with parent (server installs sinks once at boot). */
  readonly sync: SyncState

  /** True only for the process root runtime. Affects dispose() semantics. */
  readonly #isRoot: boolean

  // ── ALS plumbing ───────────────────────────────────────────────
  static #als = new AsyncLocalStorage<AgentRuntime>()
  static #root: AgentRuntime | null = null

  constructor(options: AgentRuntimeOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.signal = options.signal ?? null
    this.#isRoot = options.isRoot === true

    // Inherit infrastructure from parent (defaults to root). Skipped for
    // the root itself: it has no parent and starts with blank slates.
    const parent: AgentRuntime | null = this.#isRoot
      ? null
      : (options.inheritFrom ?? AgentRuntime.#root)

    if (parent) {
      // Process-wide infrastructure — shared by reference.
      this.mssql = {
        databases: parent.mssql.databases,
        defaultConnection: parent.mssql.defaultConnection,
        profileDataCalled: new Set<string>(),
      }
      this.shell = {
        cwd: parent.shell.cwd,
        executor: parent.shell.executor,
        sandboxStrict: parent.shell.sandboxStrict,
        killSignal: null,
      }
      this.browserCheck = {
        cwd: parent.browserCheck.cwd,
        executor: parent.browserCheck.executor,
      }
      this.browseWeb = {
        sessions: new Map(),
        counter: 0,
        killSignal: null,
        cleanupTimer: parent.browseWeb.cleanupTimer,
        contextProvider: parent.browseWeb.contextProvider,
        credentialProvider: parent.browseWeb.credentialProvider,
        handoffProvider: parent.browseWeb.handoffProvider,
      }
      this.fetchUrl = { killSignal: null }
      this.filesystem = { basePath: parent.filesystem.basePath }
      this.searchFiles = {
        basePath: parent.searchFiles.basePath,
        excludeDirs: parent.searchFiles.excludeDirs,
      }
      // Catalog and sync are shared whole — they hold expensive caches and
      // server-installed sinks that are inherently process-wide.
      this.catalog = parent.catalog
      this.sync = parent.sync
      // Memory writer is per-run — child runs start unbound; the server
      // re-binds for each top-level run (sub-runs share working memory by
      // session id, so deferring writes to the parent's writer is fine).
      this.memory = { writeNote: parent.memory.writeNote }
      // Tool-knowledge cache: copy callbacks into a fresh object so per-run
      // mutations (e.g. tests installing stub callbacks) do not bleed back
      // into the parent / root runtime.
      this.toolKnowledge = {
        lookup: parent.toolKnowledge.lookup,
        save: parent.toolKnowledge.save,
        renderHeader: parent.toolKnowledge.renderHeader,
      }
      // Verdicts reader follows the same pattern as toolKnowledge — copy
      // the callback by VALUE so per-run test stubs don't leak into the
      // parent runtime.
      this.tableVerdicts = { list: parent.tableVerdicts.list }
    } else {
      // Root: fresh defaults everywhere.
      this.mssql = { databases: new Map(), defaultConnection: null, profileDataCalled: new Set<string>() }
      this.browseWeb = { sessions: new Map(), counter: 0, killSignal: null, cleanupTimer: null, contextProvider: null, credentialProvider: null, handoffProvider: null }
      this.shell = { cwd: process.cwd(), executor: null, sandboxStrict: false, killSignal: null }
      this.browserCheck = { cwd: process.cwd(), executor: null }
      this.fetchUrl = { killSignal: null }
      this.filesystem = { basePath: process.cwd() }
      this.searchFiles = { basePath: process.cwd(), excludeDirs: new Set() }
      this.catalog = { instances: new Map(), defaultCachePath: undefined }
      this.sync = {
        eventSink: () => { /* default no-op */ },
        runSink: NOOP_RUN_SINK,
        recipes: { bundle: null, loadedFromPath: null },
        environments: new Map(),
        plans: { diskRoot: null, memCache: new Map() },
        dbProjectRoot: null,
      }
      this.memory = { writeNote: null }
      this.toolKnowledge = { lookup: null, save: null, renderHeader: null }
      this.tableVerdicts = { list: null }
    }
  }

  /**
   * The default runtime. Used when no `AgentRuntime#run(...)` scope is
   * active — i.e. server startup, CLI bootstrap, and tests. The server
   * configures this one (mssql connections, sync sinks, executors) at
   * boot. Per-request runtimes constructed later inherit those settings.
   */
  static root(): AgentRuntime {
    if (!AgentRuntime.#root) AgentRuntime.#root = new AgentRuntime({ isRoot: true })
    return AgentRuntime.#root
  }

  /**
   * The runtime active in the calling async context. Falls back to
   * {@link root} when no scope is active.
   *
   * Tools call this (via the `currentRuntime()` helper) instead of holding
   * module-level state.
   */
  static current(): AgentRuntime {
    return AgentRuntime.#als.getStore() ?? AgentRuntime.root()
  }

  /**
   * Run `fn` with this runtime as `AgentRuntime.current()` for its async
   * context. The `Agent` loop wraps each `agent.run()` invocation in this
   * so every tool call sees the right runtime.
   */
  run<T>(fn: () => T): T {
    return AgentRuntime.#als.run(this, fn)
  }

  /**
   * Release every resource owned by the runtime.
   *
   *   - Always closes this runtime's browse-web sessions.
   *   - Root only: closes mssql pools and the cleanup timer (process-wide).
   *
   * Idempotent and safe to call from a shutdown hook. After disposal,
   * callers should not reuse the runtime — make a fresh one.
   */
  async dispose(): Promise<void> {
    // Always: this runtime's own browser sessions
    for (const [id, session] of this.browseWeb.sessions) {
      try { await session.browser.close() } catch { /* ignore */ }
      this.browseWeb.sessions.delete(id)
    }
    if (!this.#isRoot) return

    // Root-only: shared infrastructure
    if (this.browseWeb.cleanupTimer) {
      clearInterval(this.browseWeb.cleanupTimer)
      this.browseWeb.cleanupTimer = null
    }
    for (const entry of this.mssql.databases.values()) {
      if (entry.pool) {
        try { await entry.pool.close() } catch { /* ignore */ }
        entry.pool = null
      }
    }
    this.mssql.databases.clear()
  }
}

export interface AgentRuntimeOptions {
  workspaceRoot?: string
  signal?: AbortSignal | null
  /**
   * Inherit shared infrastructure (pool registry, executors, caches, sync
   * sinks) from this runtime. Defaults to the process root. Pass `null` /
   * set `isRoot: true` to construct a runtime with no parent at all
   * (only the root itself does this).
   */
  inheritFrom?: AgentRuntime | null
  /** Internal flag — only `AgentRuntime.root()` sets this. */
  isRoot?: boolean
}

/** Convenience accessor — equivalent to `AgentRuntime.current()`. */
export function currentRuntime(): AgentRuntime {
  return AgentRuntime.current()
}

/**
 * Back-compat shim for the previous `getDefaultAgentRuntime()` symbol —
 * returns the root runtime. New code should use {@link AgentRuntime.root}
 * or {@link currentRuntime} directly.
 *
 * @internal
 */
export function getDefaultAgentRuntime(): AgentRuntime {
  return AgentRuntime.root()
}
